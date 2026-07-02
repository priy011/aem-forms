// ── Helpers (not exported — not visible in Rule Editor) ───────────────────────

function siblingPath(pageName) {
  const clean = globalThis.location.pathname.replace(/\.html\/?$/, '').replace(/\/$/, '');
  return `${clean.replace(/\/[^/]+$/, '')}/${pageName}`;
}

function showFormError(globals, message) {
  // Try to surface the error via a known error text field; fall back to alert
  const errorField = globals.form?.errorMessage ?? globals.form?.apiError;
  if (errorField && globals.functions?.setValue) {
    globals.functions.setValue(errorField, message);
    globals.functions.setProperty(errorField, { visible: true });
  } else {
    // eslint-disable-next-line no-alert
    alert(message);
  }
}

// ── Custom Functions (exported → appear in AEM Rule Editor) ───────────────────

/**
 * Get Full Name
 * @name getFullName Concats first name and last name
 * @param {string} firstname in Stringformat
 * @param {string} lastname in Stringformat
 * @return {string}
 */
function getFullName(firstname, lastname) {
  return `${firstname} ${lastname}`.trim();
}

/**
 * Calculate the number of days between two dates.
 * @name days Days between two dates
 * @param {*} endDate
 * @param {*} startDate
 * @returns {number} returns the number of days between two dates
 */
function days(endDate, startDate) {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? new Date(endDate) : endDate;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.floor(Math.abs(end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Masks the first 5 digits of the mobile number with *
 * @name maskMobileNumber Masks first 5 digits of mobile number
 * @param {*} mobileNumber
 * @returns {string} returns the mobile number with first 5 digits masked
 */
function maskMobileNumber(mobileNumber) {
  if (!mobileNumber) return '';
  const value = mobileNumber.toString();
  return ` ${'*'.repeat(5)}${value.substring(5)}`;
}

/**
 * Custom submit function — converts array fields to comma-separated strings before submit.
 * @name submitFormArrayToString Submit form converting arrays to strings
 * @param {scope} globals
 */
function submitFormArrayToString(globals) {
  const data = globals.functions.exportData();
  Object.keys(data).forEach((key) => {
    if (Array.isArray(data[key])) data[key] = data[key].join(',');
  });
  globals.functions.submitForm(data, true, 'application/json');
}

/**
 * Validates inputs, calls InitiateCustomerIdentification API, then navigates to the OTP page.
 * Wire to the "View Loan Eligibility" button click rule in Rule Editor:
 *   On click → Call Function → initiateIdentificationAndNavigate(mobileNo, identifierType, identifierValue)
 * @name initiateIdentificationAndNavigate Initiates loan journey and navigates to OTP page
 * @param {string} mobileNo - Aadhaar-linked 10-digit mobile number
 * @param {string} identifierName - PAN_NO or DOB
 * @param {string} identifierValue - PAN card number or date of birth (YYYY-MM-DD)
 * @param {scope} globals - AEM Forms global scope
 * @return {void}
 */
async function initiateIdentificationAndNavigate(mobileNo, identifierName, identifierValue, globals) {
  if (!mobileNo || !/^[6-9]\d{9}$/.test(mobileNo)) {
    showFormError(globals, 'Please enter a valid 10-digit mobile number.');
    return;
  }
  if (identifierName === 'PAN_NO') {
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(identifierValue)) {
      showFormError(globals, 'Please enter a valid PAN number (e.g. ABCDE1234F).');
      return;
    }
  } else {
    const ageYears = (Date.now() - new Date(identifierValue)) / (365.25 * 24 * 3600 * 1000);
    if (!identifierValue || Number.isNaN(ageYears) || ageYears < 18) {
      showFormError(globals, 'Applicant must be at least 18 years old.');
      return;
    }
  }

  try {
    const { initiateCustomerIdentification } = await import('../../scripts/api-service.js');
    const result = await initiateCustomerIdentification(mobileNo, identifierName, identifierValue);

    if (result.status.responseCode === '0') {
      sessionStorage.setItem('maskedMobile', `*****${mobileNo.slice(5)}`);
      globalThis.location.href = `${siblingPath('personal-loan-otp')}.html`;
    } else {
      showFormError(globals, result.status.errorDesc || 'Unable to process request. Please try again.');
    }
  } catch (err) {
    const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
    // eslint-disable-next-line no-console
    console.error(`[Journey: ${jid}] InitiateCustomerIdentification failed:`, err.message);
    showFormError(globals, 'Something went wrong. Please try again.');
  }
}

/**
 * Validates OTP, fetches customer offer details, then navigates to the Offer page.
 * Wire to the Submit button click rule on the OTP page:
 *   On click → Call Function → verifyOtpAndNavigate(otpValue)
 * @name verifyOtpAndNavigate Verifies OTP and navigates to offer page
 * @param {string} otp - 6-digit OTP entered by the customer
 * @param {scope} globals - AEM Forms global scope
 * @return {void}
 */
async function verifyOtpAndNavigate(otp, globals) {
  if (!otp || String(otp).length !== 6) {
    showFormError(globals, 'Please enter the 6-digit OTP.');
    return;
  }

  try {
    const { verifyOTPAndGetDemogDetails } = await import('../../scripts/api-service.js');
    const result = await verifyOTPAndGetDemogDetails(String(otp));

    if (result.status.responseCode === '0') {
      globalThis.location.href = `${siblingPath('personal-loan-offer')}.html`;
    } else {
      showFormError(globals, result.status.errorDesc || 'Invalid OTP. Please try again.');
    }
  } catch (err) {
    const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
    // eslint-disable-next-line no-console
    console.error(`[Journey: ${jid}] VerifyOTP failed:`, err.message);
    showFormError(globals, 'Something went wrong. Please try again.');
  }
}

/**
 * Submits the confirmed loan application and navigates to the Thank You page.
 * Wire to the Confirm button click rule on the Preview page:
 *   On click → Call Function → submitLoanAndNavigate(bankJourneyID, customerID, offerAmount, tenure, rateOfInterest)
 * @name submitLoanAndNavigate Submits loan application and navigates to thank you page
 * @param {string} bankJourneyID - Journey ID from the identification step
 * @param {string} customerID - Customer ID from offer details
 * @param {number} offerAmount - Selected loan amount
 * @param {number} tenure - Selected tenure in months
 * @param {string} rateOfInterest - Interest rate from offer
 * @param {scope} globals - AEM Forms global scope
 * @return {void}
 */
async function submitLoanAndNavigate(
  bankJourneyID,
  customerID,
  offerAmount,
  tenure,
  rateOfInterest,
  globals,
) {
  try {
    const { submitLoanApplication } = await import('../../scripts/api-service.js');
    const result = await submitLoanApplication({
      bankJourneyID,
      customerID,
      offerAmount,
      tenure,
      rateOfInterest,
    });

    if (result.status.responseCode === '0') {
      globalThis.location.href = `${siblingPath('personal-loan-thankyou')}.html`;
    } else {
      showFormError(globals, result.status.errorDesc || 'Submission failed. Please try again.');
    }
  } catch (err) {
    const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
    // eslint-disable-next-line no-console
    console.error(`[Journey: ${jid}] SubmitLoanApplication failed:`, err.message);
    showFormError(globals, 'Something went wrong. Please try again.');
  }
}

export {
  getFullName,
  days,
  maskMobileNumber,
  submitFormArrayToString,
  initiateIdentificationAndNavigate,
  verifyOtpAndNavigate,
  submitLoanAndNavigate,
};
