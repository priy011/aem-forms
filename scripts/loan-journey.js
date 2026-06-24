import { initiateCustomerIdentification, verifyOTPAndGetDemogDetails } from './api-service.js';

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
        globalThis.location.href = siblingPath('personal-loan-otp');
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();

    const otp = form.querySelector('[name="otpValue"]')?.value?.trim();
    if (!otp || otp.length !== 6) {
      showError(form, 'Please enter the 6-digit OTP.');
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const result = await verifyOTPAndGetDemogDetails(otp);
      if (result.status.responseCode === '0') {
        globalThis.location.href = siblingPath('personal-loan-offer');
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

function showError(form, message) {
  let errorEl = form.querySelector('.loan-api-error');
  if (!errorEl) {
    errorEl = document.createElement('p');
    errorEl.className = 'loan-api-error';
    form.prepend(errorEl);
  }
  errorEl.textContent = message;
}
