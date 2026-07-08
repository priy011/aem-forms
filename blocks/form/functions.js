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
 * Custom submit function
 * @param {scope} globals
 */
function submitFormArrayToString(globals) {
  const data = globals.functions.exportData();
  Object.keys(data).forEach((key) => {
    if (Array.isArray(data[key])) {
      data[key] = data[key].join(',');
    }
  });
  globals.functions.submitForm(data, true, 'application/json');
}

/**
 * Calculate the number of days between two dates.
 * @param {*} endDate
 * @param {*} startDate
 * @returns {number} returns the number of days between two dates
 */
function days(endDate, startDate) {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? new Date(endDate) : endDate;

  // return zero if dates are valid
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }

  const diffInMs = Math.abs(end.getTime() - start.getTime());
  return Math.floor(diffInMs / (1000 * 60 * 60 * 24));
}

/**
* Masks the first 5 digits of the mobile number with *
* @param {*} mobileNumber
* @returns {string} returns the mobile number with first 5 digits masked
*/
function maskMobileNumber(mobileNumber) {
  if (!mobileNumber) {
    return '';
  }
  const value = mobileNumber.toString();
  // Mask first 5 digits and keep the rest
  return ` ${'*'.repeat(5)}${value.substring(5)}`;
}

/**
 * Calls the InitiateCustomerIdentification mock API and navigates to the OTP page on success.
 * Wire this to the "View Loan Eligibility" button click rule in Universal Editor.
 * @name initiateIdentificationAndNavigate Initiates customer identification and navigates to OTP page
 * @param {string} mobileNo - 10-digit mobile number
 * @param {string} identifierName - PAN_NO or DOB
 * @param {string} identifierValue - PAN value or date of birth
 * @param {scope} globals - Form globals object
 * @return {void}
 */
async function initiateIdentificationAndNavigate(mobileNo, identifierName, identifierValue, globals) {
  // Client-side validation before hitting the API
  if (!mobileNo || !/^[6-9]\d{9}$/.test(mobileNo)) {
    globals.functions.setProperty(globals.form, { enabled: true });
    alert('Please enter a valid 10-digit mobile number.');
    return;
  }

  try {
    const { initiateCustomerIdentification } = await import('../../scripts/api-service.js');
    const result = await initiateCustomerIdentification(mobileNo, identifierName, identifierValue);

    if (result.status.responseCode === '0') {
      // Store masked mobile for display on OTP page — no full number in storage
      sessionStorage.setItem('maskedMobile', `*****${mobileNo.slice(5)}`);
      globalThis.location.href = '/personal-loan-otp';
    } else {
      alert(result.status.errorDesc || 'Unable to process request. Please try again.');
    }
  } catch (err) {
    const journeyId = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
    // Log journey ID only — never log PII
    console.error(`[Journey: ${journeyId}] InitiateCustomerIdentification failed:`, err.message);
    alert('Something went wrong. Please try again.');
  }
}

/**
 * Validates OTP, fetches customer/offer data, then navigates to the Offer page.
 * Wire to the Submit button click rule on the OTP page.
 * @name verifyOtpAndNavigate Verifies OTP and navigates to offer display page
 * @param {string} otp - 6-digit OTP entered by user
 * @param {scope} globals - Form globals object
 * @return {void}
 */
async function verifyOtpAndNavigate(otp, globals) {
  if (!otp || otp.length !== 6) {
    alert('Please enter the 6-digit OTP.');
    return;
  }

  try {
    const { verifyOTPAndGetDemogDetails } = await import('../../scripts/api-service.js');
    const result = await verifyOTPAndGetDemogDetails(otp);

    if (result.status.responseCode === '0') {
      globalThis.location.href = '/personal-loan-offer';
    } else {
      alert(result.status.errorDesc || 'Invalid OTP. Please try again.');
    }
  } catch (err) {
    const journeyId = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
    console.error(`[Journey: ${journeyId}] VerifyOTP failed:`, err.message);
    alert('Something went wrong. Please try again.');
  }
}

/**
 * Returns true if the applicant is at least 18 years old.
 * Use in Rule Editor condition to show/hide the DOB error field and enable/disable 
the submit button:
 *   When dobValue changes → If validateAge(dobValue) is false → Show dob-error-msg
 *   When dobValue changes → If validateAge(dobValue) is true  → Hide dob-error-msg
 * @name validateAge Checks if applicant is 18 or older
 * @param {string} dob - Date of birth in YYYY-MM-DD or DD/MM/YYYY format
 * @return {boolean} true if age >= 18, false otherwise
 */
function validateAge(dob) {
  if (!dob) return false;
  const parsed = new Date(dob);
  if (Number.isNaN(parsed.getTime())) return false;
  const age = (Date.now() - parsed) / (365.25 * 24 * 3600 * 1000);
  return age >= 21;
}

// eslint-disable-next-line import/prefer-default-export
export {
  getFullName,
  days,
  submitFormArrayToString,
  maskMobileNumber,
  validateAge,
  initiateIdentificationAndNavigate,
  verifyOtpAndNavigate,
};
