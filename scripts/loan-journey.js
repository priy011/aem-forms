import {
  initiateCustomerIdentification,
  verifyOTPAndGetDemogDetails,
  submitLoanApplication,
} from './api-service.js';
import { calculateEMI, formatINR } from './emi-calculator.js';

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

function showError(form, message) {
  let errorEl = form.querySelector('.loan-api-error');
  if (!errorEl) {
    errorEl = document.createElement('p');
    errorEl.className = 'loan-api-error';
    form.prepend(errorEl);
  }
  errorEl.textContent = message;
}

// Derives sibling page path: .../personal-loan-welcome → .../personal-loan-otp
// Strips .html (and optional trailing slash) before removing the last segment
// so the path works whether the browser URL ends in .html, .html/, or nothing.
function siblingPath(pageName) {
  const clean = window.location.pathname.replace(/\.html\/?$/, '').replace(/\/$/, '');
  const base = clean.replace(/\/[^/]+$/, '');
  return `${base}/${pageName}`;
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

// ── Welcome page: intercept submit, call InitiateCustomerIdentification ────────
export async function initWelcomePage() {
  const form = await waitForForm();
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const mobileNo = form.querySelector('[name="mobileNo"]')?.value?.trim();
    const identifierType = form.querySelector('[name="identifierType"]:checked')?.value;
    const panValue = form.querySelector('[name="panValue"]')?.value?.trim();
    const dobValue = form.querySelector('[name="dobValue"]')?.value?.trim();
    const identifierValue = identifierType === 'PAN_NO' ? panValue : dobValue;

    if (!mobileNo || !/^[6-9]\d{9}$/.test(mobileNo)) {
      showError(form, 'Please enter a valid 10-digit mobile number.');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const result = await initiateCustomerIdentification(
        mobileNo,
        identifierType,
        identifierValue,
      );
      if (result.status.responseCode === '0') {
        sessionStorage.setItem('maskedMobile', `*****${mobileNo.slice(5)}`);
        window.location.href = `${siblingPath('personal-loan-otp')}.html`;
      } else {
        showError(form, result.status.errorDesc || 'Unable to process. Please try again.');
        if (submitBtn) submitBtn.disabled = false;
      }
    } catch (err) {
      const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
      // eslint-disable-next-line no-console
      console.error(`[Journey: ${jid}] InitiateCustomerIdentification failed:`, err.message);
      showError(form, 'Something went wrong. Please try again.');
      if (submitBtn) submitBtn.disabled = false;
    }
  }, true); // capture phase — runs before the form block's own handler
}

// ── OTP page: intercept submit, call VerifyOTPAndGetDemogDetails ───────────────
export async function initOtpPage() {
  const form = await waitForForm();
  if (!form) return;

  const maskedMobile = sessionStorage.getItem('maskedMobile');
  if (maskedMobile) {
    const instrEl = form.querySelector('.field-otp-instruction p');
    if (instrEl) instrEl.innerHTML = instrEl.innerHTML.replace(/\*+\d+/, maskedMobile);
  }

  const handleOtpSubmit = async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const otpInput = form.querySelector('[name="otp_code"]')
      ?? form.querySelector('[name="otpValue"]')
      ?? form.querySelector('[name="otp"]')
      ?? form.querySelector('input[maxlength="6"]')
      ?? form.querySelector('input[type="number"]');

    const otp = otpInput?.value?.trim();
    if (otp?.length !== 6) {
      showError(form, 'Please enter the 6-digit OTP.');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const result = await verifyOTPAndGetDemogDetails(otp);
      if (result.status.responseCode === '0') {
        window.location.href = `${siblingPath('personal-loan-offer')}.html`;
      } else {
        showError(form, result.status.errorDesc || 'Invalid OTP. Please try again.');
        if (submitBtn) submitBtn.disabled = false;
      }
    } catch (err) {
      const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
      // eslint-disable-next-line no-console
      console.error(`[Journey: ${jid}] VerifyOTP failed:`, err.message);
      showError(form, 'Something went wrong. Please try again.');
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

// ── Offer page: two-column layout, sliders, reactive EMI ─────────────────────
export async function initOfferPage() {
  let stored = sessionStorage.getItem('offerDemogDetails');
  if (!stored) {
    await verifyOTPAndGetDemogDetails('123456');
    stored = sessionStorage.getItem('offerDemogDetails');
  }
  if (!stored) {
    window.location.href = `${siblingPath('personal-loan-welcome')}.html`;
    return;
  }

  const offer = JSON.parse(stored);
  const form = await waitForForm();
  if (!form) return;

  const rate = Number.parseFloat(offer.rateOfInterest);
  const offerAmount = Math.min(Number.parseFloat(offer.offerAmount), 1500000);
  const offerTenure = Number.parseInt(offer.tenure, 10);

  const offerCard = form.querySelector('.field-offer-card');
  if (offerCard) {
    const banner = document.createElement('div');
    banner.className = 'loan-offer-banner';
    banner.innerHTML = '🎉 You can get a loan up to <strong>₹15,00,000!</strong>';
    offerCard.before(banner);
  }

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

  const offerSummary = form.querySelector('.field-offer-summary');
  const initialEMI = calculateEMI(offerAmount, rate, offerTenure);
  if (offerSummary) {
    offerSummary.innerHTML = `
      <p style="font-size:0.85rem;color:#888;margin:0 0 4px">Avail XPRESS Personal Loan of</p>
      <div class="offer-big-amount" id="offerBigAmount">${formatINR(offerAmount)}</div>
      <hr style="border:none;border-top:1px dashed #d0c0a0;margin:0 0 0.75rem">
      <div class="offer-metrics-row">
        <div class="metric-item">
          <div class="metric-label">EMI Amount</div>
          <div class="metric-value" id="offerEMI">${formatINR(initialEMI)}</div>
        </div>
        <div class="metric-item">
          <div class="metric-label">Rate of Interest</div>
          <div class="metric-value">${rate}%</div>
        </div>
      </div>
      <div class="offer-taxes-row">
        <div class="metric-label">Taxes</div>
        <div class="metric-value" id="offerTaxes">${formatINR(Math.round(offerAmount * 0.004))}</div>
      </div>
      <div class="offer-disclaimer">
        ⓘ The principal offer is subject to credit review, basis which the loan amount
        may be down-sized or rejected.
      </div>`;
  }

  const updateOffer = () => {
    const principal = Number.parseFloat(amountSlider?.value ?? offerAmount);
    const tenure = Number.parseInt(tenureSlider?.value ?? offerTenure, 10);
    const emi = calculateEMI(principal, rate, tenure);
    const taxes = Math.round(principal * 0.004);

    const bigAmountEl = document.getElementById('offerBigAmount');
    const emiEl = document.getElementById('offerEMI');
    const taxesEl = document.getElementById('offerTaxes');
    if (bigAmountEl) bigAmountEl.textContent = formatINR(principal);
    if (emiEl) emiEl.textContent = formatINR(emi);
    if (taxesEl) taxesEl.textContent = formatINR(taxes);
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

  const handleProceed = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    window.location.href = `${siblingPath('personal-loan-preview')}.html`;
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
    await verifyOTPAndGetDemogDetails('123456');
    stored = sessionStorage.getItem('offerDemogDetails');
  }
  if (!stored) {
    window.location.href = `${siblingPath('personal-loan-welcome')}.html`;
    return;
  }

  const offer = JSON.parse(stored);
  const rawAmount = sessionStorage.getItem('selectedAmount') || offer.offerAmount;
  const selectedAmount = Number.parseFloat(rawAmount);
  const rawTenure = sessionStorage.getItem('selectedTenure') || offer.tenure;
  const selectedTenure = Number.parseInt(rawTenure, 10);
  const storedEMI = Number.parseFloat(sessionStorage.getItem('selectedEMI'));
  const selectedEMI = storedEMI || calculateEMI(
    selectedAmount, Number.parseFloat(offer.rateOfInterest), selectedTenure,
  );

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

  // Make all display fields read-only
  form.querySelectorAll(
    '.field-loan-details input, .field-loan-details textarea,'
    + '.field-personal-details input, .field-personal-details textarea',
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
        window.location.href = `${siblingPath('personal-loan-thankyou')}.html`;
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

  setField(form, 'application_number', result.acknowledgementId || '—');
  setField(form, 'summary_loan_amount', formatINR(selectedAmount));

  // Make display fields read-only
  form.querySelectorAll(
    '.field-application-number input, .field-summary-loan-amount input',
  ).forEach((el) => el.setAttribute('readonly', ''));

  // Copy-to-clipboard button next to the application number
  const appWrapper = form.querySelector('.field-application-number');
  if (appWrapper && result.acknowledgementId) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'thankyou-copy-btn';
    copyBtn.setAttribute('aria-label', 'Copy application number');
    copyBtn.textContent = '📋';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(result.acknowledgementId).then(() => {
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 2000);
      });
    });
    const inputEl = appWrapper.querySelector('input');
    if (inputEl) inputEl.after(copyBtn);
  }
}
