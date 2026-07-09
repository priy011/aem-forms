import {
  verifyOTPAndGetDemogDetails,
  submitLoanApplication,
  generateEmailOTP,
  validateEmailOTP,
  getBureauOffer,
} from './api-service.js';
import { calculateEMI, formatINR } from './emi-calculator.js';
import { checkValidation } from '../blocks/form/util.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function waitForForm() {
  return new Promise((resolve) => {
    const existing = document.querySelector('form');
    if (existing) { resolve(existing); return; }

    const observer = new MutationObserver(() => {
      const form = document.querySelector('form');
      if (form) { observer.disconnect(); resolve(form); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, 5000);
  });
}

function setField(form, name, value) {
  const el = form.querySelector(`[name="${name}"]`);
  if (el) el.value = value;
}

function clearError(form) {
  form.querySelector('.loan-api-error')?.remove();
}

function showError(form, message) {
  clearError(form);
  const errorEl = document.createElement('p');
  errorEl.className = 'loan-api-error';
  errorEl.textContent = message;
  form.prepend(errorEl);
}

// Derives sibling page path: .../personal-loan-welcome → .../personal-loan-otp
// Strips from the first /personal-loan-* segment to end so it works on both EDS
// (e.g. /personal-loan-offer.html) and AEM authoring paths that have extra segments
// after the form name (e.g. /content/dam/.../personal-loan-offer/jcr:content).
function siblingPath(pageName) {
  const clean = globalThis.location.pathname.replace(/\.html\/?$/, '').replace(/\/$/, '');
  const base = clean.replace(/\/personal-loan-[^/].*$/, '');
  return `${base}/${pageName}`;
}

// ── Analytics ─────────────────────────────────────────────────────────────────
// Pushes structured events to window.dataLayer (GTM / Adobe Analytics).
// Falls back to console.info for non-instrumented environments.
function trackEvent(eventName, payload = {}) {
  const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
  const event = {
    event: eventName,
    journeyId: jid,
    timestamp: Date.now(),
    ...payload,
  };
  if (globalThis.dataLayer) globalThis.dataLayer.push(event);
  // eslint-disable-next-line no-console
  console.info('[Analytics]', eventName, event);
}

function isAgeValid(dob) {
  if (!dob) return false;
  const years = (Date.now() - new Date(dob)) / (365.25 * 24 * 3600 * 1000);
  return !Number.isNaN(years) && years >= 21;
}

// AEM slider uses --current-steps CSS var to draw the filled track.
// Setting .value via JS moves the thumb but NOT the track — sync it manually.
function syncSliderTrack(slider) {
  if (!slider) return;
  const wrapper = slider.closest('.range-widget-wrapper');
  if (!wrapper) return;
  const min = Number.parseFloat(slider.min) || 0;
  const max = Number.parseFloat(slider.max) || 100;
  const val = Number.parseFloat(slider.value) || min;
  wrapper.style.setProperty('--total-steps', String(max - min));
  wrapper.style.setProperty('--current-steps', String(val - min));
}

function addSliderExtras(slider, initialValue, ticks) {
  if (!slider) return null;
  const fieldWrapper = slider.closest('.field-wrapper');
  const label = fieldWrapper?.querySelector('label');

  const pill = document.createElement('span');
  pill.className = 'offer-value-pill';
  pill.textContent = initialValue;
  label?.after(pill);

  const ticksEl = document.createElement('div');
  ticksEl.className = 'offer-slider-ticks';
  ticks.forEach((t) => {
    const span = document.createElement('span');
    span.textContent = t;
    ticksEl.appendChild(span);
  });
  slider.closest('.range-widget-wrapper')?.after(ticksEl);

  return pill;
}

// ── OTP resend timer: countdown → Resend button → max 3 attempts ─────────────
function startOtpTimer(form) {
  const timerEl = form.querySelector('.field-resend-otp-timer p');
  const attemptsEl = form.querySelector('.field-attempts-left p');
  const maxAttempts = 3;
  let attemptsLeft = maxAttempts;
  let secondsLeft = 30;
  let interval = null;

  function updateAttemptsDisplay() {
    if (attemptsEl) attemptsEl.innerHTML = `${attemptsLeft}/${maxAttempts} attempt(s) left`;
  }

  function showResendButton() {
    if (!timerEl) return;
    timerEl.innerHTML = '';
    if (attemptsLeft <= 0) {
      timerEl.textContent = 'No more resend attempts allowed.';
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'resend-otp-btn';
    btn.textContent = 'Resend OTP';
    btn.addEventListener('click', () => {
      form.querySelector('.otp-inline-error')?.remove();
      const newOtp = String(Math.floor(100000 + Math.random() * 900000));
      sessionStorage.setItem('mobileOtp', newOtp);
      const otpInput = form.querySelector('[name="otp_code"]')
        ?? form.querySelector('[name="otpValue"]')
        ?? form.querySelector('[name="otp"]')
        ?? form.querySelector('input[type="password"]')
        ?? form.querySelector('input[type="number"]');
      if (otpInput) otpInput.value = newOtp;
      attemptsLeft -= 1;
      updateAttemptsDisplay();
      startCountdown(); // eslint-disable-line no-use-before-define
    });
    timerEl.appendChild(btn);
  }

  function startCountdown() {
    clearInterval(interval);
    secondsLeft = 30;
    if (timerEl) timerEl.innerHTML = `Resend OTP in: <b>${secondsLeft} secs</b>`;
    interval = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft > 0) {
        if (timerEl) timerEl.innerHTML = `Resend OTP in: <b>${secondsLeft} secs</b>`;
      } else {
        clearInterval(interval);
        showResendButton();
      }
    }, 1000);
  }

  updateAttemptsDisplay();
  startCountdown();
}

// ── Welcome page ─────────────────────────────────────────────────────────────
export async function initWelcomePage() {
  const form = await waitForForm();
  if (!form) return;

  trackEvent('welcome_pageLoad');

  const mobileInput = form.querySelector('[name="mobileNo"]');
  const identifierRadios = form.querySelectorAll('[name="identifierType"]');
  const panWrapper = form.querySelector('.field-panvalue');
  const panInput = form.querySelector('[name="panValue"]');
  const dobWrapper = form.querySelector('.field-dobvalue');
  const dobInput = form.querySelector('[name="dobValue"]');
  const consentInput = form.querySelector('[name="consentData"]');
  const consentMktInput = form.querySelector('[name="consentMarketing"]');
  const submitBtn = form.querySelector('button[type="submit"]');

  if (submitBtn) submitBtn.disabled = true;

  // Restrict DOB picker to dates where the applicant is at least 21 years old
  if (dobInput) {
    const maxDob = new Date();
    maxDob.setFullYear(maxDob.getFullYear() - 21);
    const [maxDobDate] = maxDob.toISOString().split('T');
    dobInput.max = maxDobDate;
  }

  // ── PAN ↔ DOB toggle ────────────────────────────────────────────────────────
  function getIdentifierType() {
    return [...identifierRadios].find((r) => r.checked)?.value ?? '';
  }

  function syncIdentifierVisibility() {
    const type = getIdentifierType();
    panWrapper?.setAttribute('data-visible', type === 'DOB' ? 'false' : 'true');
    dobWrapper?.setAttribute('data-visible', type === 'DOB' ? 'true' : 'false');
  }

  identifierRadios.forEach((r) => r.addEventListener('change', syncIdentifierVisibility));
  syncIdentifierVisibility();

  // ── DOB inline error (show after date is picked) ────────────────────────────
  dobInput?.addEventListener('change', () => {
    const dob = dobInput.value;
    const parsed = new Date(dob);
    let msg = '';
    if (dob && Number.isNaN(parsed.getTime())) {
      msg = 'Please enter a valid date of birth.';
    } else if (dob && parsed > new Date()) {
      msg = 'Date of birth cannot be a future date.';
    } else if (dob && !isAgeValid(dob)) {
      msg = 'Applicant must be at least 21 years old.';
    }
    dobInput.setCustomValidity(msg);
    checkValidation(dobInput);
  });

  // ── Button enable / disable ─────────────────────────────────────────────────
  function checkFormValid() {
    if (!/^[6-9]\d{9}$/.test(mobileInput?.value ?? '')) return false;
    const type = getIdentifierType();
    if (!type) return false;
    if (type === 'PAN_NO' && !/^[A-Z]{5}\d{4}[A-Z]$/.test(panInput?.value ?? '')) return false;
    if (type !== 'PAN_NO') {
      const dob = dobInput?.value;
      const parsed = new Date(dob);
      if (!dob || Number.isNaN(parsed.getTime()) || parsed > new Date() || !isAgeValid(dob)) {
        return false;
      }
    }
    if (!consentInput?.checked) return false;
    if (!consentMktInput?.checked) return false;
    return true;
  }

  function updateSubmitBtn() {
    if (submitBtn) submitBtn.disabled = !checkFormValid();
  }

  // Mobile: strip non-digits and cap at 10 characters, then update button + inline error
  mobileInput?.addEventListener('input', () => {
    const digits = mobileInput.value.replace(/\D/g, '').slice(0, 10);
    if (mobileInput.value !== digits) mobileInput.value = digits;
    updateSubmitBtn();
    if (mobileInput.validity.valid) checkValidation(mobileInput);
  });
  mobileInput?.addEventListener('blur', () => {
    if (mobileInput.value) checkValidation(mobileInput);
  });

  // PAN: auto-uppercase, then update button + inline error
  panInput?.addEventListener('input', () => {
    const upper = panInput.value.toUpperCase();
    if (panInput.value !== upper) panInput.value = upper;
    updateSubmitBtn();
    if (panInput.validity.valid) checkValidation(panInput);
  });
  panInput?.addEventListener('blur', () => {
    if (panInput.value) checkValidation(panInput);
  });

  identifierRadios.forEach((r) => r.addEventListener('change', updateSubmitBtn));
  dobInput?.addEventListener('change', updateSubmitBtn);
  consentInput?.addEventListener('change', updateSubmitBtn);
  consentMktInput?.addEventListener('change', updateSubmitBtn);

  // Block native form submit so the Rule Editor Invoke Service is the only navigation trigger.
  // Without this the browser reloads the page on every click, cancelling the async Invoke Service.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Disable on click to prevent stacked Invoke Service calls while the async request is in flight.
  // Save masked mobile so the OTP page can display it in the instruction text.
  // 8-second safety re-enables the button if navigation never fires (e.g. Rule Editor failure).
  submitBtn?.addEventListener('click', () => {
    submitBtn.disabled = true;
    const mobile = mobileInput?.value ?? '';
    if (mobile) sessionStorage.setItem('maskedMobile', `*****${mobile.slice(5)}`);
    setTimeout(() => {
      if (document.contains(submitBtn)) submitBtn.disabled = !checkFormValid();
    }, 8000);
  });
}

// ── OTP page: intercept submit, call VerifyOTPAndGetDemogDetails ───────────────
export async function initOtpPage() {
  const form = await waitForForm();
  if (!form) return;

  trackEvent('otp_pageLoad');

  // Ensure an OTP exists — generate one if the welcome page didn't store one
  // (e.g. direct navigation during testing, or Rule Engine skipped the Invoke Service).
  let mobileOtp = sessionStorage.getItem('mobileOtp');
  if (!mobileOtp) {
    mobileOtp = String(Math.floor(100000 + Math.random() * 900000));
    sessionStorage.setItem('mobileOtp', mobileOtp);
  }

  // Pre-fill using the same fallback selector chain as the submit handler,
  // and re-apply once the Rule Engine finishes initializing (removes "loading" class).
  const findOtpInput = () => form.querySelector('[name="otp_code"]')
    ?? form.querySelector('[name="otpValue"]')
    ?? form.querySelector('[name="otp"]')
    ?? form.querySelector('input[type="password"]')
    ?? form.querySelector('input[type="number"]');
  const applyOtp = () => {
    const el = findOtpInput();
    if (el) el.value = mobileOtp;
  };
  applyOtp();
  if (form.classList.contains('loading')) {
    const otpPrefillObs = new MutationObserver(() => {
      if (!form.classList.contains('loading')) { otpPrefillObs.disconnect(); applyOtp(); }
    });
    otpPrefillObs.observe(form, { attributes: true, attributeFilter: ['class'] });
  }

  // Fill the dedicated otp_masked_mobile field with the masked number from sessionStorage
  // and move the "Edit mobile number" <a> from the instruction field to sit right after it.
  // Result: instruction shows static text, masked-mobile field shows "*****94837. [Edit link]".
  const maskedMobile = sessionStorage.getItem('maskedMobile');
  const instrWrapper = form.querySelector('.field-otp-instruction');
  const maskedFieldPara = form.querySelector('.field-otp-masked-mobile p');
  const editLink = instrWrapper?.querySelector('a');

  if (maskedMobile && maskedFieldPara) {
    maskedFieldPara.textContent = `${maskedMobile} `;
    if (editLink) maskedFieldPara.appendChild(editLink);
  }

  // Intercept the Edit link wherever it lives after the DOM rearrangement above.
  editLink?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    globalThis.location.href = `${siblingPath('personal-loan-welcome')}.html`;
  });

  // Show errors inline, right below the OTP password field (not prepended to form).
  const showOtpError = (msg) => {
    form.querySelector('.otp-inline-error')?.remove();
    const errEl = document.createElement('p');
    errEl.className = 'loan-api-error otp-inline-error';
    errEl.textContent = msg;
    const anchor = form.querySelector('.field-otp-code');
    if (anchor) anchor.after(errEl);
    else form.prepend(errEl);
  };

  const handleOtpSubmit = async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const otpInput = form.querySelector('[name="otp_code"]')
      ?? form.querySelector('[name="otpValue"]')
      ?? form.querySelector('[name="otp"]')
      ?? form.querySelector('input[type="password"]')
      ?? form.querySelector('input[type="number"]');

    const otp = otpInput?.value?.trim();
    if (otp?.length !== 6) {
      showOtpError('Please enter the 6-digit OTP.');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const result = await verifyOTPAndGetDemogDetails(otp);
      if (result.status.responseCode === '0') {
        trackEvent('otp_success');
        globalThis.location.href = `${siblingPath('personal-loan-personal-info')}.html`;
      } else {
        trackEvent('otp_failure', { errorCode: result.status.errorCode });
        showOtpError(result.status.errorDesc || 'Invalid OTP. Please try again.');
        if (submitBtn) submitBtn.disabled = false;
      }
    } catch (err) {
      const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
      // eslint-disable-next-line no-console
      console.error(`[Journey: ${jid}] VerifyOTP failed:`, err.message);
      trackEvent('otp_failure', { errorCode: 'EXCEPTION' });
      showOtpError('Something went wrong. Please try again.');
      if (submitBtn) submitBtn.disabled = false;
    }
  };

  form.addEventListener('submit', handleOtpSubmit, true);
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleOtpSubmit(e);
  }, true);

  startOtpTimer(form);
}

// ── Personal Info page: pre-fill from API data, email verify, confirm ────────
// AEM Forms lowercases camelCase field names for CSS classes (no hyphens added):
//   fullNameDisplay  → .field-fullnamedisplay   (readonly plain-text)
//   firstName        → .field-firstname
//   middleName       → .field-middlename
//   lastName         → .field-lastname
//   gender           → .field-gender            (dropdown)
//   emailId          → .field-emailid
//   verifyEmailBtn   → .field-verifyemailbtn    (button type="button")
//   emailOtpInput    → .field-emailotpinput     (text, hidden initially)
//   submitEmailOtp   → .field-submitemailotp    (button, hidden initially)
//   emailVerifiedMsg → .field-emailverifiedmsg  (plain-text, hidden initially)
//   aadhaarAddress   → .field-aadhaaraddress    (readonly)
//   addressType      → .field-addresstype       (radio group)
//   employerNameText → .field-employernametext
//   industryType     → .field-industrytype
//   monthlyIncome    → .field-monthlyincome
//   ongoingEmis      → .field-ongoingemis
//   loanType         → .field-loantype          (dropdown)
export async function initPersonalInfoPage() {
  let stored = sessionStorage.getItem('offerDemogDetails');
  if (!stored) {
    let demoOtp = sessionStorage.getItem('mobileOtp');
    if (!demoOtp) {
      demoOtp = String(Math.floor(100000 + Math.random() * 900000));
      sessionStorage.setItem('mobileOtp', demoOtp);
    }
    await verifyOTPAndGetDemogDetails(demoOtp);
    stored = sessionStorage.getItem('offerDemogDetails');
  }
  if (!stored) {
    globalThis.location.href = `${siblingPath('personal-loan-welcome')}.html`;
    return;
  }

  const offer = JSON.parse(stored);
  const form = await waitForForm();
  if (!form) return;

  trackEvent('personalInfo_pageLoad');

  // ── Pre-fill from OTP API response ─────────────────────────────────────────
  const fullName = [offer.customerFirstName, offer.customerMiddleName, offer.customerLastName]
    .map((s) => (s || '').trim()).filter(Boolean).join(' ');
  const address = [
    offer.customerAddress1,
    offer.customerAddress2,
    offer.customerCity,
    `${offer.customerState || ''} - ${offer.zipCode || ''}`,
  ].filter(Boolean).join(', ');

  setField(form, 'fullNameDisplay', fullName);
  setField(form, 'firstName', (offer.customerFirstName || '').trim());
  setField(form, 'middleName', (offer.customerMiddleName || '').trim());
  setField(form, 'lastName', (offer.customerLastName || '').trim());
  setField(form, 'aadhaarAddress', address);
  setField(form, 'emailId', offer.emailAddress || '');
  setField(form, 'pan_number', offer.maskedPan || '');
  setField(form, 'employerNameText', offer.employerName || '');
  setField(form, 'loanType', offer.typeOfLoan || 'Fresh Loan');

  form.querySelector('[name="fullNameDisplay"]')?.setAttribute('readonly', '');
  form.querySelector('[name="aadhaarAddress"]')?.setAttribute('readonly', '');
  form.querySelector('[name="pan_number"]')?.setAttribute('readonly', '');

  // ── Email OTP verification — toggling authored fields ──────────────────────
  const otpInputWrapper = form.querySelector('.field-emailotpinput');
  const submitOtpWrapper = form.querySelector('.field-submitemailotp');
  const verifiedMsgWrapper = form.querySelector('.field-emailverifiedmsg');
  otpInputWrapper?.setAttribute('data-visible', 'false');
  submitOtpWrapper?.setAttribute('data-visible', 'false');
  verifiedMsgWrapper?.setAttribute('data-visible', 'false');

  // ── Accordion toggle for collapsible panels ────────────────────────────────
  form.querySelectorAll('.field-employerdetails, .field-incomedetails, .field-loantypedetails')
    .forEach((panel) => {
      panel.querySelector('legend')?.addEventListener('click', () => {
        const collapsed = panel.getAttribute('data-collapsed') === 'true';
        panel.setAttribute('data-collapsed', String(!collapsed));
      });
    });

  form.addEventListener('click', async (e) => {
    // ── Verify email button ──────────────────────────────────────────────────
    const verifyBtn = e.target.closest('.field-verifyemailbtn button');
    if (verifyBtn) {
      const email = form.querySelector('[name="emailId"]')?.value?.trim();
      if (!email) { showError(form, 'Please enter your email address first.'); return; }
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Sending…';
      const result = await generateEmailOTP(email);
      if (result.status.responseCode === '0') {
        otpInputWrapper?.setAttribute('data-visible', 'true');
        submitOtpWrapper?.setAttribute('data-visible', 'true');
        const emailOtp = sessionStorage.getItem('emailOtp');
        if (emailOtp) setField(form, 'emailOtpInput', emailOtp);
        verifyBtn.textContent = 'Resend OTP';
        verifyBtn.disabled = false;
      } else {
        showError(form, result.status.errorDesc || 'Could not send OTP to that address.');
        verifyBtn.textContent = 'Verify';
        verifyBtn.disabled = false;
      }
    }

    // ── Submit email OTP button ──────────────────────────────────────────────
    const submitOtpBtn = e.target.closest('.field-submitemailotp button');
    if (submitOtpBtn) {
      const email = form.querySelector('[name="emailId"]')?.value?.trim();
      const otp = form.querySelector('[name="emailOtpInput"]')?.value?.trim();
      if (!otp || otp.length !== 6) return;
      submitOtpBtn.disabled = true;
      const otpResult = await validateEmailOTP(email, otp);
      if (otpResult.status.responseCode === '0') {
        otpInputWrapper?.setAttribute('data-visible', 'false');
        submitOtpWrapper?.setAttribute('data-visible', 'false');
        verifiedMsgWrapper?.setAttribute('data-visible', 'true');
        form.querySelector('.field-verifyemailbtn')?.setAttribute('data-visible', 'false');
        sessionStorage.setItem('verifiedEmail', email);
        trackEvent('email_verified');
      } else {
        showError(form, otpResult.status.errorDesc || 'Invalid email OTP. Please try again.');
        submitOtpBtn.disabled = false;
      }
    }
  });

  // ── Confirm → persist personal info + navigate to offer ───────────────────
  const handleConfirm = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const emailValue = form.querySelector('[name="emailId"]')?.value?.trim();
    if (emailValue && !sessionStorage.getItem('verifiedEmail')) {
      showError(form, 'Please verify your email address before proceeding.');
      form.querySelector('.field-emailid input')?.focus();
      return;
    }

    const personalInfoData = {
      firstName: form.querySelector('[name="firstName"]')?.value || '',
      middleName: form.querySelector('[name="middleName"]')?.value || '',
      lastName: form.querySelector('[name="lastName"]')?.value || '',
      gender: form.querySelector('[name="gender"]')?.value || '',
      emailId: form.querySelector('[name="emailId"]')?.value || '',
      addressType: form.querySelector('[name="addressType"]:checked')?.value || 'Both',
      employerName: form.querySelector('[name="employerNameText"]')?.value || '',
      industryType: form.querySelector('[name="industryType"]')?.value || '',
      monthlyIncome: form.querySelector('[name="monthlyIncome"]')?.value || '',
      ongoingEmis: form.querySelector('[name="ongoingEmis"]')?.value || '',
      loanType: form.querySelector('[name="loanType"]')?.value || 'Fresh Loan',
      officeAddress: form.querySelector('[name="officeAddress"]')?.value || '',
      referenceFullName: form.querySelector('[name="referenceFullName"]')?.value || '',
      referenceMobile: form.querySelector('[name="referenceMobile"]')?.value || '',
    };
    sessionStorage.setItem('personalInfoData', JSON.stringify(personalInfoData));
    trackEvent('personalInfo_confirmed', { loanType: personalInfoData.loanType });
    globalThis.location.href = `${siblingPath('personal-loan-get-bureau-offer')}.html`;
  };

  form.addEventListener('submit', handleConfirm, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleConfirm(e);
  }, true);
}

// ── GetBureauOffer page: bank selection + income verification ─────────────────
export async function initBureauOfferPage() {
  let stored = sessionStorage.getItem('offerDemogDetails');
  if (!stored) {
    let demoOtp = sessionStorage.getItem('mobileOtp');
    if (!demoOtp) {
      demoOtp = String(Math.floor(100000 + Math.random() * 900000));
      sessionStorage.setItem('mobileOtp', demoOtp);
    }
    await verifyOTPAndGetDemogDetails(demoOtp);
    stored = sessionStorage.getItem('offerDemogDetails');
  }
  if (!stored) {
    globalThis.location.href = `${siblingPath('personal-loan-welcome')}.html`;
    return;
  }

  const offer = JSON.parse(stored);
  const form = await waitForForm();
  if (!form) return;

  const handleContinue = async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const continueBtn = form.querySelector('button[type="submit"]');
    if (continueBtn) {
      continueBtn.disabled = true;
      continueBtn.textContent = 'Processing…';
    }

    try {
      const result = await getBureauOffer({
        customerID: offer.customerID,
        bankJourneyID: sessionStorage.getItem('bankJourneyID'),
        selectedBank: form.querySelector('[name="selectedBank"]:checked')?.value || '',
        incomeMethod: form.querySelector('[name="incomeMethod"]:checked')?.value || '',
      });

      if (result.status.responseCode === '0') {
        sessionStorage.setItem('offerDemogDetails', JSON.stringify({ ...offer, ...result.responseString }));
        globalThis.location.href = `${siblingPath('personal-loan-offer')}.html`;
      } else {
        showError(form, result.status.errorDesc || 'Failed to fetch bureau offer. Please try again.');
        if (continueBtn) {
          continueBtn.disabled = false;
          continueBtn.textContent = 'Continue';
        }
      }
    } catch (err) {
      const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
      console.error(`[Journey: ${jid}] GetBureauOffer failed:`, err.message);
      showError(form, 'Something went wrong. Please try again.');
      if (continueBtn) {
        continueBtn.disabled = false;
        continueBtn.textContent = 'Continue';
      }
    }
  };

  form.addEventListener('submit', handleContinue, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleContinue(e);
  }, true);
}

// ── Offer page: two-column layout, sliders, reactive EMI ─────────────────────
export async function initOfferPage() {
  let stored = sessionStorage.getItem('offerDemogDetails');
  if (!stored) {
    // Fallback for authoring / direct navigation: ensure a valid OTP exists so the
    // mock API validation passes and demo data is loaded without triggering a redirect.
    let demoOtp = sessionStorage.getItem('mobileOtp');
    if (!demoOtp) {
      demoOtp = String(Math.floor(100000 + Math.random() * 900000));
      sessionStorage.setItem('mobileOtp', demoOtp);
    }
    await verifyOTPAndGetDemogDetails(demoOtp);
    stored = sessionStorage.getItem('offerDemogDetails');
  }
  if (!stored) {
    globalThis.location.href = `${siblingPath('personal-loan-welcome')}.html`;
    return;
  }

  const offer = JSON.parse(stored);
  const form = await waitForForm();
  if (!form) return;

  const rate = Number.parseFloat(offer.rateOfInterest);
  const offerAmount = Math.min(Number.parseFloat(offer.offerAmount), 1500000);
  const offerTenure = Number.parseInt(offer.tenure, 10);

  const amountSlider = form.querySelector('[name="loanAmount"]');
  const tenureSlider = form.querySelector('[name="loanTenure"]');

  if (amountSlider) {
    amountSlider.min = 50000;
    amountSlider.max = 1500000;
    amountSlider.step = 50000;
    amountSlider.value = offerAmount;
    syncSliderTrack(amountSlider);
  }
  if (tenureSlider) {
    tenureSlider.min = 12;
    tenureSlider.max = 84;
    tenureSlider.step = 12;
    tenureSlider.value = offerTenure;
    syncSliderTrack(tenureSlider);
  }

  const amountPill = addSliderExtras(
    amountSlider,
    formatINR(offerAmount),
    ['50K', '2L', '4L', '6L', '8L', '10L', '12L', '15L'],
  );
  const tenurePill = addSliderExtras(
    tenureSlider,
    `${offerTenure} months`,
    ['12m', '24m', '36m', '48m', '60m', '72m', '84m'],
  );

  // Populate authored offer summary fields.
  // taxes = 18% GST on the processing fee returned by the API.
  // The taxes field is not readonly in authoring, so the Rule Engine can reset it to
  // empty when it restores form state (sync-complete). Re-apply it once loading is done.
  const fullName = [offer.customerFirstName, offer.customerLastName].filter(Boolean).join(' ');
  const processingFee = Number.parseFloat(offer.processingFee || '0');
  const taxes = Math.round(processingFee * 0.18);
  const applyTaxes = () => setField(form, 'taxes', formatINR(taxes));

  setField(form, 'customerName', fullName);
  setField(form, 'loanAmountDisplay', formatINR(offerAmount));
  setField(form, 'monthlyEMI', formatINR(calculateEMI(offerAmount, rate, offerTenure)));
  setField(form, 'interestRate', `${rate}%`);
  applyTaxes();

  // Re-apply once the Rule Engine finishes restoring form state (removes "loading" class).
  if (form.classList.contains('loading')) {
    const obs = new MutationObserver(() => {
      if (!form.classList.contains('loading')) { obs.disconnect(); applyTaxes(); }
    });
    obs.observe(form, { attributes: true, attributeFilter: ['class'] });
  }

  const updateOffer = () => {
    const principal = Number.parseFloat(amountSlider?.value ?? offerAmount);
    const tenure = Number.parseInt(tenureSlider?.value ?? offerTenure, 10);
    const emi = calculateEMI(principal, rate, tenure);

    setField(form, 'loanAmountDisplay', formatINR(principal));
    setField(form, 'monthlyEMI', formatINR(emi));
    applyTaxes();
    if (amountPill) amountPill.textContent = formatINR(principal);
    if (tenurePill) tenurePill.textContent = `${tenure} months`;
    syncSliderTrack(amountSlider);
    syncSliderTrack(tenureSlider);

    sessionStorage.setItem('selectedAmount', principal);
    sessionStorage.setItem('selectedTenure', tenure);
    sessionStorage.setItem('selectedEMI', emi);
  };

  amountSlider?.addEventListener('input', updateOffer);
  amountSlider?.addEventListener('change', updateOffer);
  tenureSlider?.addEventListener('input', updateOffer);
  tenureSlider?.addEventListener('change', updateOffer);

  trackEvent('offer_pageLoad');

  const handleProceed = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    trackEvent('offer_selected', {
      amount: amountSlider?.value ?? offerAmount,
      tenure: tenureSlider?.value ?? offerTenure,
      rate,
    });
    globalThis.location.href = `${siblingPath('personal-loan-preview')}.html`;
  };

  form.addEventListener('submit', handleProceed, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleProceed(e);
  }, true);
}

// ── Preview page: review summary + confirm → submitLoanApplication ────────────
export async function initPreviewPage() {
  let stored = sessionStorage.getItem('offerDemogDetails');
  if (!stored) {
    let demoOtp = sessionStorage.getItem('mobileOtp');
    if (!demoOtp) {
      demoOtp = String(Math.floor(100000 + Math.random() * 900000));
      sessionStorage.setItem('mobileOtp', demoOtp);
    }
    await verifyOTPAndGetDemogDetails(demoOtp);
    stored = sessionStorage.getItem('offerDemogDetails');
  }
  if (!stored) {
    globalThis.location.href = `${siblingPath('personal-loan-welcome')}.html`;
    return;
  }

  const offer = JSON.parse(stored);
  const rawAmount = sessionStorage.getItem('selectedAmount') || offer.offerAmount;
  const selectedAmount = Number.parseFloat(rawAmount);
  const rawTenure = sessionStorage.getItem('selectedTenure') || offer.tenure;
  const selectedTenure = Number.parseInt(rawTenure, 10);
  const storedEMI = Number.parseFloat(sessionStorage.getItem('selectedEMI'));
  const roi = Number.parseFloat(offer.rateOfInterest);
  const selectedEMI = storedEMI || calculateEMI(selectedAmount, roi, selectedTenure);

  const fullName = [offer.customerFirstName, offer.customerLastName]
    .filter(Boolean).join(' ');
  const processingFee = Number.parseFloat(offer.processingFee || '0');
  const address = [
    offer.customerAddress1,
    offer.customerAddress2,
    offer.customerCity,
    `${offer.customerState} - ${offer.zipCode}`,
  ].filter(Boolean).join(', ');

  const form = await waitForForm();
  if (!form) return;

  // Populate loan details fields authored in AEM
  setField(form, 'loan_amount_display', formatINR(selectedAmount));
  setField(form, 'emi_amount_display', formatINR(selectedEMI));
  setField(form, 'tenure_display', `${selectedTenure} months`);
  setField(form, 'processing_fee_display', formatINR(processingFee));
  setField(form, 'rate_display', `${offer.rateOfInterest}%`);
  setField(form, 'employer_display', offer.employerName || '—');
  setField(form, 'schedule_charges', 'Click here');
  setField(form, 'type_of_loan_display', offer.typeOfLoan || 'Fresh Loan');

  // Populate personal details fields authored in AEM
  setField(form, 'full_name_display', fullName || '—');
  setField(form, 'mobile_display', `+91 ${offer.customerMobileNo || ''}`);
  setField(form, 'dob_display', offer.dateOfBirth || '—');
  setField(form, 'pan_display', offer.maskedPan || '—');
  setField(form, 'address_display', address || '—');
  setField(form, 'residence_display', offer.residenceType || '—');

  // Populate salary account details (from bureau offer merged into offerDemogDetails)
  setField(form, 'salary_account_number', offer.salaryAccountNumber || '—');
  setField(form, 'salary_ifsc_display', offer.ifscCode || '—');
  setField(form, 'salary_bank_display', offer.bankName || '—');

  // Populate office address and reference details from personal info form
  const personalInfo = JSON.parse(sessionStorage.getItem('personalInfoData') || '{}');
  setField(form, 'office_address_display', personalInfo.officeAddress || offer.employerName || '—');
  setField(form, 'reference_name_display', personalInfo.referenceFullName || '—');
  setField(form, 'reference_mobile_display', personalInfo.referenceMobile || '—');

  // Make all display fields read-only
  form.querySelectorAll(
    '.field-loan-details input, .field-loan-details textarea,'
    + '.field-personal-details input, .field-personal-details textarea,'
    + '.field-salary-details input, .field-salary-details textarea,'
    + '.field-office-address input, .field-office-address textarea,'
    + '.field-reference-details input, .field-reference-details textarea',
  ).forEach((el) => el.setAttribute('readonly', ''));

  const handleConfirm = async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const confirmBtn = form.querySelector('button[type="submit"]');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Submitting…';
    }

    try {
      const result = await submitLoanApplication({
        bankJourneyID: sessionStorage.getItem('bankJourneyID'),
        customerID: offer.customerID,
        offerAmount: selectedAmount,
        tenure: selectedTenure,
        rateOfInterest: offer.rateOfInterest,
      });

      if (result.status.responseCode === '0') {
        globalThis.location.href = `${siblingPath('personal-loan-thankyou')}.html`;
      } else {
        showError(form, result.status.errorDesc || 'Submission failed. Please try again.');
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm';
        }
      }
    } catch (err) {
      const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
      // eslint-disable-next-line no-console
      console.error(`[Journey: ${jid}] SubmitLoanApplication failed:`, err.message);
      showError(form, 'Something went wrong. Please try again.');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm';
      }
    }
  };

  form.addEventListener('submit', handleConfirm, true);
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleConfirm(e);
  }, true);
}

// ── Thank You page: populate acknowledgement ID + loan amount ─────────────────
export async function initThankYouPage() {
  const resultRaw = sessionStorage.getItem('submissionResult');
  const result = resultRaw ? JSON.parse(resultRaw) : {};
  const rawAmount = sessionStorage.getItem('selectedAmount');
  const selectedAmount = Number.parseFloat(rawAmount || '0');

  const form = await waitForForm();
  if (!form) return;

  trackEvent('submission_success', {
    acknowledgementId: result.acknowledgementId,
    amount: selectedAmount,
  });

  setField(form, 'application_number', result.acknowledgementId || '—');
  setField(form, 'summary_loan_amount', formatINR(selectedAmount));

  // Make display fields read-only
  form.querySelectorAll(
    '.field-application-number input, .field-summary-loan-amount input',
  ).forEach((el) => el.setAttribute('readonly', ''));
}
