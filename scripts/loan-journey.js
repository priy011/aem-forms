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

  // Update masked mobile from sessionStorage if available
  const maskedMobile = sessionStorage.getItem('maskedMobile');
  if (maskedMobile) {
    const instrEl = form.querySelector('.field-otp-instruction p');
    if (instrEl) instrEl.innerHTML = instrEl.innerHTML.replace(/\*+\d+/, maskedMobile);
  }

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

// ── Offer page: two-column layout, sliders, reactive EMI ─────────────────────
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

  // Blue banner above the sliders
  const offerCard = form.querySelector('.field-offer-card');
  if (offerCard) {
    const banner = document.createElement('div');
    banner.className = 'loan-offer-banner';
    banner.innerHTML = `🎉 You can get a loan up to <strong>₹15,00,000!</strong>`;
    offerCard.before(banner);
  }

  // Initialise sliders
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

  const amountPill = addSliderExtras(amountSlider, formatINR(offerAmount),
    ['50K', '2L', '4L', '6L', '8L', '10L', '12L', '15L']);
  const tenurePill = addSliderExtras(tenureSlider, `${offerTenure} months`,
    ['12m', '24m', '36m', '48m', '60m', '72m', '84m']);

  // Replace offer-summary fieldset with styled card HTML
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
        ⓘ The principal offer is subject to credit review, basis which the loan amount may be down-sized or rejected.
      </div>`;
  }

  // Reactive update on slider move
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
    globalThis.location.href = `${siblingPath('personal-loan-preview')}.html?ref=capstone`;
  };

  form.addEventListener('submit', handleProceed, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[type="submit"]');
    if (btn && form.contains(btn)) handleProceed(e);
  }, true);
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
