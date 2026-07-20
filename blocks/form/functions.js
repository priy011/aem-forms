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
  if (otp?.length !== 6) {
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
 * Validates that the applicant's age falls within the configured eligible range.
 *
 * The min and max age limits are read from the DOB field's properties, which are
 * set by a content author in AEM Universal Editor (Validation tab → "Minimum eligible
 * age" / "Maximum eligible age").  No code change or deployment is needed when
 * the business requirement changes — the author simply updates the field property.
 *
 * Rule Editor usage:
 *   When dobValue changes
 *     → If validateEligibleAge(dobValue, $globals) is false
 *       → Set focus on dobValue   (field error is shown automatically)
 *
 * The field's "Script validation message" (validateExpMessage) in AEM Author should
 * be set to something like "Applicant age must be between {minAge} and {maxAge} years."
 * Authors update both the message and the numeric limits together in one place.
 *
 * @name validateEligibleAge Validates applicant age against authored min/max limits
 * @param {string} dob     - Date of birth (YYYY-MM-DD or any Date-parseable string)
 * @param {scope}  globals - AEM Forms globals object (injected by the rule engine)
 * @return {boolean} true if age is within [minEligibleAge, maxEligibleAge], false otherwise
 */
function validateEligibleAge(dob, globals) {
  if (!dob) return false;

  const parsed = new Date(dob);
  if (Number.isNaN(parsed.getTime())) return false;

  // Read limits authored on the field.  globals.field is the DOB field the rule
  // is attached to; its .properties object carries the values set in Universal Editor.
  const fieldProps = globals?.field?.properties ?? {};
  const minAge = Number(fieldProps.minEligibleAge ?? 21);
  const maxAge = Number(fieldProps.maxEligibleAge ?? 65);

  const ageYears = (Date.now() - parsed.getTime()) / (365.25 * 24 * 3600 * 1000);
  return ageYears >= minAge && ageYears <= maxAge;
}

/**
 * Returns a human-readable explanation of why the age check failed.
 * Wire this to a plain-text / error field to show a specific message:
 *
 *   When dobValue changes
 *     → If validateEligibleAge(dobValue, $globals) is false
 *       → Set value of dob-error-msg to getAgeValidationMessage(dobValue, $globals)
 *
 * @name getAgeValidationMessage Returns the reason the age validation failed
 * @param {string} dob     - Date of birth
 * @param {scope}  globals - AEM Forms globals object
 * @return {string} Empty string if valid; descriptive message if invalid
 */
function getAgeValidationMessage(dob, globals) {
  if (!dob) return 'Please enter your date of birth.';

  const parsed = new Date(dob);
  if (Number.isNaN(parsed.getTime())) return 'Please enter a valid date of birth.';

  const fieldProps = globals?.field?.properties ?? {};
  const minAge = Number(fieldProps.minEligibleAge ?? 21);
  const maxAge = Number(fieldProps.maxEligibleAge ?? 65);

  const ageYears = (Date.now() - parsed.getTime()) / (365.25 * 24 * 3600 * 1000);

  if (ageYears < minAge) {
    return `Applicant must be at least ${minAge} years old to apply for this loan.`;
  }
  if (ageYears > maxAge) {
    return `Applicant must be below ${maxAge} years of age to be eligible for this loan.`;
  }
  return '';
}

// eslint-disable-next-line import/prefer-default-export
export {
  getFullName,
  days,
  submitFormArrayToString,
  maskMobileNumber,
  validateEligibleAge,
  getAgeValidationMessage,
  initiateIdentificationAndNavigate,
  verifyOtpAndNavigate,
};
