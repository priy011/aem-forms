import { initiateCustomerIdentification, verifyOTPAndGetDemogDetails } from './api-service.js';
import { calculateEMI, formatINR } from './emi-calculator.js';

// Derives sibling page path: .../personal-loan-welcome → .../personal-loan-otp
function siblingPath(pageName) {
  const base = globalThis.location.pathname.replace(/\/[^/]+$/, '');
  return `${base}/${pageName}`;
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
      const result = await initiateCustomerIdentification(mobileNo, identifierType, identifierValue);
      if (result.status.responseCode === '0') {
        sessionStorage.setItem('maskedMobile', `*****${mobileNo.slice(5)}`);
        globalThis.location.href = `${siblingPath('personal-loan-otp')}.html?ref=capstone`;
      } else {
        showError(form, result.status.errorDesc || 'Unable to process. Please try again.');
        if (submitBtn) submitBtn.disabled = false;
      }
    } catch (err) {
      const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
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

  const handleOtpSubmit = async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    // Try multiple possible field names used by AEM OTP components
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
        globalThis.location.href = `${siblingPath('personal-loan-offer')}.html?ref=capstone`;
      } else {
        showError(form, result.status.errorDesc || 'Invalid OTP. Please try again.');
        if (submitBtn) submitBtn.disabled = false;
      }
    } catch (err) {
      const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
      console.error(`[Journey: ${jid}] VerifyOTP failed:`, err.message);
      showError(form, 'Something went wrong. Please try again.');
      if (submitBtn) submitBtn.disabled = false;
    }
  };

  // Intercept both form submit and button click (AEM OTP component uses click, not submit)
  form.addEventListener('submit', handleOtpSubmit, true);
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleOtpSubmit(e);
  }, true);
}

// ── Offer page: sliders + reactive EMI from sessionStorage offer data ─────────
export async function initOfferPage() {
  const stored = sessionStorage.getItem('offerDemogDetails');
  if (!stored) {
    globalThis.location.href = `${siblingPath('personal-loan-welcome')}.html?ref=capstone`;
    return;
  }

  const offer = JSON.parse(stored);
  const form = await waitForForm();
  if (!form) return;

  const rate = Number.parseFloat(offer.rateOfInterest);
  const offerAmount = Math.min(Number.parseFloat(offer.offerAmount), 1500000);
  const offerTenure = Number.parseInt(offer.tenure, 10);

  // Set slider attributes and initial values
  const amountSlider = form.querySelector('[name="loanAmount"]');
  const tenureSlider = form.querySelector('[name="loanTenure"]');

  if (amountSlider) {
    amountSlider.min = 50000;
    amountSlider.max = 1500000;
    amountSlider.step = 50000;
    amountSlider.value = offerAmount;
  }
  if (tenureSlider) {
    tenureSlider.min = 12;
    tenureSlider.max = 84;
    tenureSlider.step = 12;
    tenureSlider.value = offerTenure;
  }

  setField(form, 'customerName', `${offer.customerFirstName} ${offer.customerLastName}`.trim());
  setField(form, 'interestRate', `${rate}% p.a.`);

  // Recalculates and updates the right panel on every slider change
  const updateOffer = () => {
    const principal = Number.parseFloat(amountSlider?.value ?? offerAmount);
    const tenure = Number.parseInt(tenureSlider?.value ?? offerTenure, 10);
    const emi = calculateEMI(principal, rate, tenure);
    setField(form, 'loanAmountDisplay', formatINR(principal));
    setField(form, 'monthlyEMI', formatINR(emi));
    sessionStorage.setItem('selectedAmount', principal);
    sessionStorage.setItem('selectedTenure', tenure);
    sessionStorage.setItem('selectedEMI', emi);
  };

  updateOffer(); // initial render

  amountSlider?.addEventListener('input', updateOffer);
  tenureSlider?.addEventListener('input', updateOffer);

  const handleProceed = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    globalThis.location.href = `${siblingPath('personal-loan-preview')}.html?ref=capstone`;
  };

  form.addEventListener('submit', handleProceed, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleProceed(e);
  }, true);
}

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
