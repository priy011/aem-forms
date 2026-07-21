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

function isAgeValid(dob, minAge = 21, maxAge = 65) {
  if (!dob) return false;
  const years = (Date.now() - new Date(dob)) / (365.25 * 24 * 3600 * 1000);
  return !Number.isNaN(years) && years >= minAge && years <= maxAge;
}

// Injects a Verify button + OTP row into a plain text-input field wrapper and
// OTP-gates it via the generateEmailOTP/validateEmailOTP mock APIs. Used for
// panels (e.g. the Preview page's Verify Email ID panel) whose fields are
// authored as bare inputs, with no separate verify/otp/submit fields.
function setupEmailVerification(form, wrapperClass) {
  const wrapper = form.querySelector(`.${wrapperClass}`);
  const input = wrapper?.querySelector('input');
  if (!wrapper || !input) return null;

  const descriptionEl = wrapper.querySelector('.field-description');

  // Insertion order matters: the description must always render directly
  // below the input, so verify/OTP/badge all go after it (not between input
  // and description) regardless of whether the Verify button ends up sharing
  // the input's row or wrapping to its own.
  const verifyBtn = document.createElement('button');
  verifyBtn.type = 'button';
  verifyBtn.className = 'verify-email-btn';
  verifyBtn.textContent = 'Verify';
  (descriptionEl || input).after(verifyBtn);

  const otpRow = document.createElement('div');
  otpRow.className = 'email-otp-row';
  otpRow.hidden = true;
  const otpInput = document.createElement('input');
  otpInput.type = 'text';
  otpInput.inputMode = 'numeric';
  otpInput.maxLength = 6;
  otpInput.placeholder = 'Enter OTP';
  otpInput.setAttribute('aria-label', `OTP for ${wrapper.querySelector('label')?.textContent || 'email'}`);
  // otpInput lives inside the email field's own .field-wrapper (there's nowhere
  // else authored to put it), but it isn't part of the AEM Forms field model.
  // The rule engine's form-wide 'change' delegate (blocks/form/rules/index.js
  // applyRuleEngine) resolves the target field via closest('.field-wrapper'),
  // which would resolve to *this* email field and overwrite its model value
  // with the OTP text. Stop it from bubbling so that never happens.
  otpInput.addEventListener('change', (e) => e.stopPropagation());
  const otpSubmit = document.createElement('button');
  otpSubmit.type = 'button';
  otpSubmit.textContent = 'Submit';
  otpRow.append(otpInput, otpSubmit);
  verifyBtn.after(otpRow);

  const badge = document.createElement('span');
  badge.className = 'email-verified-badge';
  badge.textContent = '✓ Verified';
  badge.hidden = true;
  otpRow.after(badge);

  const storageKey = `verifiedEmail:${wrapperClass}`;
  let verified = false;

  const markVerified = (email) => {
    verified = true;
    sessionStorage.setItem(storageKey, email);
    input.value = email;
    input.setAttribute('readonly', '');
    otpRow.hidden = true;
    verifyBtn.hidden = true;
    badge.hidden = false;
  };

  const storedEmail = sessionStorage.getItem(storageKey);
  if (storedEmail) {
    input.value = storedEmail;
    markVerified(storedEmail);
  }

  verifyBtn.addEventListener('click', async () => {
    const email = input.value.trim();
    if (!email) { showError(form, 'Please enter an email address first.'); return; }
    const resending = verifyBtn.textContent === 'Resend OTP';
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Sending…';
    const result = await generateEmailOTP(email);
    if (result.status.responseCode === '0') {
      otpRow.hidden = false;
      const demoOtp = sessionStorage.getItem('emailOtp');
      if (demoOtp) otpInput.value = demoOtp;
      otpInput.focus();
      verifyBtn.textContent = 'Resend OTP';
      verifyBtn.disabled = false;
    } else {
      showError(form, result.status.errorDesc || 'Could not send OTP to that address.');
      verifyBtn.textContent = resending ? 'Resend OTP' : 'Verify';
      verifyBtn.disabled = false;
    }
  });

  otpSubmit.addEventListener('click', async () => {
    const email = input.value.trim();
    const otp = otpInput.value.trim();
    if (!otp || otp.length !== 6) { showError(form, 'Please enter the 6-digit OTP.'); return; }
    otpSubmit.disabled = true;
    const result = await validateEmailOTP(email, otp);
    if (result.status.responseCode === '0') {
      markVerified(email);
      trackEvent('email_verified', { field: wrapperClass });
    } else {
      showError(form, result.status.errorDesc || 'Invalid OTP. Please try again.');
      otpSubmit.disabled = false;
    }
  });

  return { isVerified: () => verified };
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
      timerEl.textContent = 'Resend limit reached. Redirecting to support page…';
      setTimeout(() => {
        globalThis.location.href = `${siblingPath('personal-loan-technical-issue')}.html`;
      }, 2000);
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

// ── Email domain suggestion chips ────────────────────────────────────────────
// Injects @gmail.com / @outlook.com / @yahoo.com pill buttons below the email
// input. Clicking a chip appends (or replaces) the domain part of whatever the
// user has already typed, then fires an input event so any live validation picks
// up the new value.
function addEmailDomainSuggestions(form) {
  const emailWrapper = form.querySelector('.field-emailid');
  const emailInput = emailWrapper?.querySelector('input[type="email"]');
  if (!emailWrapper || !emailInput) return;

  const chips = document.createElement('div');
  chips.className = 'email-domain-chips';

  ['@gmail.com', '@outlook.com', '@yahoo.com'].forEach((domain) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'email-domain-chip';
    chip.textContent = domain;
    chip.addEventListener('click', () => {
      const local = emailInput.value.includes('@')
        ? emailInput.value.slice(0, emailInput.value.indexOf('@'))
        : emailInput.value;
      emailInput.value = local + domain;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.focus();
    });
    chips.append(chip);
  });

  emailWrapper.append(chips);
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

  // Read age limits authored in Universal Editor (Validation tab → "Minimum / Maximum
  // eligible age").  createFieldWrapper() stores all field properties as data-* attrs,
  // so these are available on the wrapper div as soon as the form renders — no Rule
  // Editor rule or extra initialisation step needed.
  const dobMinAge = Number(dobWrapper?.dataset?.minEligibleAge ?? 21);
  const dobMaxAge = Number(dobWrapper?.dataset?.maxEligibleAge ?? 65);

  if (dobInput) {
    const today = new Date();
    dobInput.max = new Date(today.getFullYear() - dobMinAge, today.getMonth(), today.getDate())
      .toISOString().split('T')[0];
    dobInput.min = new Date(today.getFullYear() - dobMaxAge, today.getMonth(), today.getDate())
      .toISOString().split('T')[0];
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

  // ── DOB inline error (re-evaluated on every change) ────────────────────────
  dobInput?.addEventListener('change', () => {
    const dob = dobInput.value;
    const parsed = new Date(dob);
    let msg = '';
    if (dob && Number.isNaN(parsed.getTime())) {
      msg = 'Please enter a valid date of birth.';
    } else if (dob && parsed > new Date()) {
      msg = 'Date of birth cannot be a future date.';
    } else if (dob) {
      const years = (Date.now() - parsed.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (years < dobMinAge) {
        msg = `Applicant must be at least ${dobMinAge} years old to apply for this loan.`;
      } else if (years > dobMaxAge) {
        msg = `Applicant must be below ${dobMaxAge} years of age to be eligible for this loan.`;
      }
    }
    dobInput.setCustomValidity(msg);
    checkValidation(dobInput);
  });

  // ── Button enable / disable ─────────────────────────────────────────────────
  function checkFormValid() {
    if (!/^[6-9]\d{9}$/.test(mobileInput?.value ?? '')) return false;
    const type = getIdentifierType();
    if (!type) return false;
    if (type === 'PAN_NO' && !/^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/.test(panInput?.value ?? '')) return false;
    if (type !== 'PAN_NO') {
      const dob = dobInput?.value;
      const parsed = new Date(dob);
      if (!dob || Number.isNaN(parsed.getTime()) || parsed > new Date() || !isAgeValid(dob, dobMinAge, dobMaxAge)) {
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

  // Mobile: block 0-5 as the first digit — the character never appears in the field.
  // keydown handles direct keyboard input; the input handler catches paste.
  mobileInput?.addEventListener('keydown', (e) => {
    if (/^[0-5]$/.test(e.key) && mobileInput.value.replace(/\D/g, '').length === 0) {
      e.preventDefault();
    }
  });
  mobileInput?.addEventListener('input', () => {
    let digits = mobileInput.value.replace(/\D/g, '').slice(0, 10);
    // Strip a leading 0-5 that could arrive via paste or autofill
    if (/^[0-5]/.test(digits)) digits = digits.slice(1);
    if (mobileInput.value !== digits) mobileInput.value = digits;
    if (mobileInput.validity.customError) mobileInput.setCustomValidity('');
    if (mobileInput.validity.valid) checkValidation(mobileInput);
    updateSubmitBtn();
  });
  mobileInput?.addEventListener('blur', () => {
    if (mobileInput.value) checkValidation(mobileInput);
  });

  // PAN: auto-uppercase; flag 4th-character 'P' rule from the 4th keystroke onwards
  panInput?.addEventListener('input', () => {
    const upper = panInput.value.toUpperCase();
    if (panInput.value !== upper) panInput.value = upper;
    const val = panInput.value;
    let msg = '';
    if (val.length >= 4 && val[3] !== 'P') {
      msg = 'The 4th character of PAN must be "P" for individual applicants (e.g. AAAPX9999Y).';
    } else if (val.length === 10 && !/^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/.test(val)) {
      msg = 'Please enter a valid PAN number (format: AAAPX9999Y).';
    }
    panInput.setCustomValidity(msg);
    if (msg || panInput.validity.valid) checkValidation(panInput);
    updateSubmitBtn();
  });
  panInput?.addEventListener('blur', () => {
    if (!panInput.value) return;
    const val = panInput.value;
    let msg = '';
    if (val[3] && val[3] !== 'P') {
      msg = 'The 4th character of PAN must be "P" for individual applicants (e.g. AAAPX9999Y).';
    } else if (!/^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/.test(val)) {
      msg = 'Please enter a valid PAN number (format: AAAPX9999Y).';
    }
    panInput.setCustomValidity(msg);
    checkValidation(panInput);
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
    if (mobile) {
      sessionStorage.setItem('maskedMobile', `******${mobile.slice(-4)}`);
      sessionStorage.setItem('welcomeMobile', mobile);
    }
    const pan = panInput?.value?.trim() ?? '';
    if (pan) sessionStorage.setItem('welcomePan', pan);
    const dob = dobInput?.value ?? '';
    if (dob) sessionStorage.setItem('welcomeDob', dob);
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

  // Replace the authored placeholder (e.g. ******6458) with the real masked number
  // from sessionStorage by walking text nodes — no DOM node rearrangement.
  const maskedMobile = sessionStorage.getItem('maskedMobile');
  const instrWrapper = form.querySelector('.field-otp-instruction');
  if (maskedMobile && instrWrapper) {
    instrWrapper.querySelectorAll('p').forEach((p) => {
      p.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          node.textContent = node.textContent.replace(/\*+\d+/, maskedMobile);
        }
      });
    });
  }

  // Intercept the "Edit mobile number" link to navigate back to the welcome page.
  const editLink = instrWrapper?.querySelector('a');
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

  let otpFailureCount = 0;
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
        otpFailureCount += 1;
        trackEvent('otp_failure', { errorCode: result.status.errorCode, attempt: otpFailureCount });
        if (otpFailureCount >= 3) {
          showOtpError('Verification failed. Redirecting to support page…');
          setTimeout(() => {
            globalThis.location.href = `${siblingPath('personal-loan-technical-issue')}.html`;
          }, 2000);
          return;
        }
        showOtpError(result.status.errorDesc || `Invalid OTP. ${3 - otpFailureCount} attempt(s) remaining.`);
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

  const welcomePan = sessionStorage.getItem('welcomePan');
  const welcomeMobile = sessionStorage.getItem('welcomeMobile');
  const welcomeDob = sessionStorage.getItem('welcomeDob');

  setField(form, 'fullNameDisplay', fullName);
  setField(form, 'firstName', (offer.customerFirstName || '').trim());
  setField(form, 'middleName', (offer.customerMiddleName || '').trim());
  setField(form, 'lastName', (offer.customerLastName || '').trim());
  setField(form, 'aadhaarAddress', address);
  setField(form, 'emailId', offer.emailAddress || '');
  setField(form, 'pan_number', welcomePan || offer.maskedPan || '');
  setField(form, 'mobile_display', welcomeMobile ? `+91 ${welcomeMobile}` : `+91 ${offer.customerMobileNo || ''}`);
  setField(form, 'dob_display', welcomeDob || offer.dateOfBirth || '');
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

  // Move Verify button inside the email field wrapper so CSS can position it inline.
  const emailFieldWrapper = form.querySelector('.field-emailid');
  const verifyBtnWrapper = form.querySelector('.field-verifyemailbtn');
  if (emailFieldWrapper && verifyBtnWrapper) emailFieldWrapper.appendChild(verifyBtnWrapper);

  // Inject @gmail.com / @outlook.com / @yahoo.com suggestion chips
  addEmailDomainSuggestions(form);

  // Show errors inside the personalDetails panel (below email field), not at form top.
  const showEmailError = (msg) => {
    form.querySelector('.email-field-error')?.remove();
    if (!msg) return;
    const err = document.createElement('p');
    err.className = 'email-field-error';
    err.textContent = msg;
    emailFieldWrapper?.after(err);
  };

  // ── Accordion toggle for collapsible panels ────────────────────────────────
  form.querySelectorAll(
    '.field-panname, .field-personaldetails, .field-addressdetails,'
    + '.field-employerdetails, .field-incomedetails, .field-loantypedetails',
  )
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
      if (!email) { showEmailError('Please enter your email address first.'); return; }
      showEmailError('');
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
        showEmailError(result.status.errorDesc || 'Could not send OTP to that address.');
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
      showEmailError('');
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
        showEmailError(otpResult.status.errorDesc || 'Invalid email OTP. Please try again.');
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
      showEmailError('Please verify your email address before proceeding.');
      form.querySelector('.field-emailid input')?.focus();
      return;
    }

    // Try multiple authored name variants for fields that may differ across form versions.
    // Uses find+querySelector pair to avoid a for loop (linter requires array iterations).
    const pick = (...names) => {
      const hit = names.find((n) => form.querySelector(`[name="${n}"]`)?.value?.trim());
      return hit ? (form.querySelector(`[name="${hit}"]`).value.trim()) : '';
    };
    const personalInfoData = {
      firstName: pick('firstName', 'first_name'),
      middleName: pick('middleName', 'middle_name'),
      lastName: pick('lastName', 'last_name'),
      gender: form.querySelector('[name="gender"]')?.value || '',
      emailId: pick('emailId', 'email_id', 'email'),
      addressType: form.querySelector('[name="addressType"]:checked')?.value || 'Both',
      employerName: pick('employerNameText', 'employer_name', 'employerName'),
      industryType: pick('industryType', 'industry_type'),
      monthlyIncome: pick('monthlyIncome', 'monthly_income'),
      ongoingEmis: pick('ongoingEmis', 'ongoing_emis'), // cspell:disable-line
      loanType: pick('loanType', 'loan_type') || 'Fresh Loan',
      officeAddress: pick('officeAddress', 'office_address'),
      referenceFullName: pick('referenceFullName', 'reference_full_name', 'refFullName', 'refName'),
      referenceMobile: pick('referenceMobile', 'reference_mobile', 'refMobile'),
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

  // Default: pre-select Account Aggregator if nothing is checked yet
  const defaultMethod = form.querySelector('[name="incomeMethod"][value="account-aggregator"]');
  if (defaultMethod && !form.querySelector('[name="incomeMethod"]:checked')) {
    defaultMethod.checked = true;
    defaultMethod.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Mutual exclusivity: Other Bank dropdown ↔ bank cards
  const otherBankSelect = form.querySelector('[name="otherBankName"]');
  const bankRadios = form.querySelectorAll('[name="selectedBank"]');

  // Inline error shown below the Other Bank dropdown
  const bankErrorAnchor = otherBankSelect?.closest('.field-wrapper') ?? null;
  const showBankError = (msg) => {
    form.querySelector('.bank-select-error')?.remove();
    if (!msg || !bankErrorAnchor) return;
    const err = document.createElement('p');
    err.className = 'bank-select-error loan-api-error';
    err.textContent = msg;
    bankErrorAnchor.after(err);
  };

  // Clear error as soon as user makes any bank selection
  otherBankSelect?.addEventListener('change', () => {
    if (otherBankSelect.value) {
      bankRadios.forEach((r) => { r.checked = false; });
      showBankError('');
    }
  });
  bankRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (otherBankSelect) otherBankSelect.value = '';
      showBankError('');
    });
  });

  const handleContinue = async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const selectedBank = form.querySelector('[name="selectedBank"]:checked')?.value
      || form.querySelector('[name="otherBankName"]')?.value?.trim()
      || '';

    if (!selectedBank) {
      showBankError('Please select your salary account bank before proceeding.');
      return;
    }

    const continueBtn = form.querySelector('button[type="submit"]');
    if (continueBtn) {
      continueBtn.disabled = true;
      continueBtn.textContent = 'Processing…';
    }

    try {
      const result = await getBureauOffer({
        customerID: offer.customerID,
        bankJourneyID: sessionStorage.getItem('bankJourneyID'),
        selectedBank, // validated non-empty above
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
  // Default sliders to maximum values (15L / 84 months) so users start with the full offer.
  const offerAmount = 1500000;
  const offerTenure = 84;

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
    ['50K', '3L', '6L', '9L', '12L', '15L'],
  );
  const tenurePill = addSliderExtras(
    tenureSlider,
    `${offerTenure} months`,
    ['12m', '24m', '36m', '48m', '60m', '72m', '84m'],
  );

  // Populate authored offer summary fields.
  // Processing fee = 1% of principal; taxes = 18% GST on processing fee.
  // Both recalculate whenever the slider moves.
  // The taxes field is not readonly in authoring, so the Rule Engine can reset it to
  // empty when it restores form state (sync-complete). Re-apply it once loading is done.
  const fullName = [offer.customerFirstName, offer.customerLastName].filter(Boolean).join(' ');

  const calcFeeAndTax = (principal) => {
    const fee = Math.round(principal * 0.01);
    const tax = Math.round(fee * 0.18);
    return { fee, tax };
  };

  const applyFeeAndTax = (principal) => {
    const { fee, tax } = calcFeeAndTax(principal);
    setField(form, 'processingFee', formatINR(fee));
    setField(form, 'taxes', formatINR(tax));
  };

  setField(form, 'customerName', fullName);
  setField(form, 'loanAmountDisplay', formatINR(offerAmount));
  setField(form, 'monthlyEMI', formatINR(calculateEMI(offerAmount, rate, offerTenure)));
  setField(form, 'interestRate', `${rate}%`);
  applyFeeAndTax(offerAmount);

  // Re-apply once the Rule Engine finishes restoring form state (removes "loading" class).
  if (form.classList.contains('loading')) {
    const obs = new MutationObserver(() => {
      if (!form.classList.contains('loading')) { obs.disconnect(); applyFeeAndTax(offerAmount); }
    });
    obs.observe(form, { attributes: true, attributeFilter: ['class'] });
  }

  const updateOffer = () => {
    const principal = Number.parseFloat(amountSlider?.value ?? offerAmount);
    const tenure = Number.parseInt(tenureSlider?.value ?? offerTenure, 10);
    const emi = calculateEMI(principal, rate, tenure);

    setField(form, 'loanAmountDisplay', formatINR(principal));
    setField(form, 'monthlyEMI', formatINR(emi));
    applyFeeAndTax(principal);
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
  // Processing fee = 1% of selected loan amount; taxes = 18% GST on that fee.
  const processingFee = Math.round(selectedAmount * 0.01);
  const address = [
    offer.customerAddress1,
    offer.customerAddress2,
    offer.customerCity,
    `${offer.customerState} - ${offer.zipCode}`,
  ].filter(Boolean).join(', ');

  const form = await waitForForm();
  if (!form) return;

  // Read personalInfoData early so it can override API values throughout
  const personalInfo = JSON.parse(sessionStorage.getItem('personalInfoData') || '{}');

  // Populate loan details fields authored in AEM
  setField(form, 'loan_amount_display', formatINR(selectedAmount));
  setField(form, 'emi_amount_display', formatINR(selectedEMI));
  setField(form, 'tenure_display', `${selectedTenure} months`);
  setField(form, 'processing_fee_display', formatINR(processingFee));
  setField(form, 'taxes_display', formatINR(Math.round(processingFee * 0.18)));
  setField(form, 'rate_display', `${offer.rateOfInterest}%`);
  setField(form, 'employer_display', personalInfo.employerName || offer.employerName || '—');
  setField(form, 'schedule_charges', 'Click here');
  // Prefer what the user selected on personal-info over the API default
  setField(form, 'type_of_loan_display', personalInfo.loanType || offer.typeOfLoan || 'Fresh Loan');

  // Populate personal details fields — prefer values the user entered on the Welcome page
  const previewMobile = sessionStorage.getItem('welcomeMobile');
  const previewDob = sessionStorage.getItem('welcomeDob');
  const previewPan = sessionStorage.getItem('welcomePan');

  setField(form, 'full_name_display', fullName || '—');
  setField(form, 'mobile_display', previewMobile ? `+91 ${previewMobile}` : `+91 ${offer.customerMobileNo || ''}`);
  setField(form, 'dob_display', previewDob || offer.dateOfBirth || '—');
  setField(form, 'pan_display', previewPan || offer.maskedPan || '—');
  setField(form, 'address_display', address || '—');
  setField(form, 'residence_display', offer.residenceType || '—');

  // Populate salary account details (merged from bureau offer API response)
  setField(form, 'salary_account_number', offer.salaryAccountNumber || '—');
  setField(form, 'salary_ifsc_display', offer.ifscCode || '—'); // cspell:disable-line
  setField(form, 'salary_bank_display', offer.bankName || '—');

  // Populate office address from personal info form
  setField(form, 'office_address_display', personalInfo.officeAddress || offer.employerName || '—');

  // Reference details from API response
  setField(form, 'reference_name_display', offer.referenceFullName || '—');
  setField(form, 'reference_mobile_display', offer.referenceMobile || '—');

  // Make all display fields read-only
  form.querySelectorAll(
    '.field-loan-details input, .field-loan-details textarea,'
    + '.field-personal-details input, .field-personal-details textarea,'
    + '.field-salary-details input, .field-salary-details textarea,'
    + '.field-office-address input, .field-office-address textarea,'
    + '.field-reference-details input, .field-reference-details textarea',
  ).forEach((el) => el.setAttribute('readonly', ''));

  // ── Collapsible panel headers (accordion) ──────────────────────────────────
  form.querySelectorAll(
    '.field-loan-details, .field-personal-details, .field-salary-details,'
    + '.field-office-address, .field-reference-details, .field-verifyemail',
  ).forEach((panel) => {
    panel.querySelector('legend')?.addEventListener('click', () => {
      const collapsed = panel.getAttribute('data-collapsed') === 'true';
      panel.setAttribute('data-collapsed', String(!collapsed));
    });
  });

  // ── Email pre-fill ─────────────────────────────────────────────────────────
  // personal-info page stores verified email as 'verifiedEmail'; setupEmailVerification
  // reads 'verifiedEmail:field-personal-email'. Bridge the gap so the email is
  // pre-populated and already-verified status carries forward to this page.
  const carriedEmail = sessionStorage.getItem('verifiedEmail')
    || personalInfo.emailId
    || offer.emailAddress
    || '';
  if (carriedEmail) {
    sessionStorage.setItem('verifiedEmail:field-personal-email', carriedEmail);
  }

  // Remove authored readonly from email inputs so setupEmailVerification can
  // manage their readonly state (it re-applies readonly when marking as verified).
  // work_email has no pre-filled source so the user must be able to type in it.
  form.querySelector('.field-personal-email input')?.removeAttribute('readonly');
  form.querySelector('.field-work-email input')?.removeAttribute('readonly');

  const personalEmailVerification = setupEmailVerification(form, 'field-personal-email');
  setupEmailVerification(form, 'field-work-email');

  const handleConfirm = async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    if (personalEmailVerification && !personalEmailVerification.isVerified()) {
      showError(form, 'Please verify your Personal Email ID before proceeding.');
      form.querySelector('.field-personal-email input')?.focus();
      return;
    }

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
