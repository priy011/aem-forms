const JOURNEY_CONTEXT = {
  partnerId: 'HDFCBANK',
  channelID: 'ADOBE',
  productName: 'PL',
  partnerJourneyID: `JOURNEY_${Date.now()}`,
};

/**
 * API 1: InitiateCustomerIdentification (mocked)
 * Sends mobile + identifier, returns offerAvailable + bankJourneyID
 */
export async function initiateCustomerIdentification(mobileNo, identifierName, identifierValue) {
  await new Promise((r) => setTimeout(r, 500));

  // Server-side input validation (independent of client-side checks)
  if (!/^[6-9]\d{9}$/.test(mobileNo)) {
    return { status: { responseCode: '1', errorCode: 'INVALID_MOBILE', errorDesc: 'Invalid mobile number format.' } };
  }
  if (identifierName === 'PAN_NO' && !/^[A-Z]{5}\d{4}[A-Z]$/.test(identifierValue)) {
    return { status: { responseCode: '1', errorCode: 'INVALID_PAN', errorDesc: 'Invalid PAN format.' } };
  }
  if (identifierName === 'DOB') {
    const age = (Date.now() - new Date(identifierValue)) / (365.25 * 24 * 3600 * 1000);
    if (Number.isNaN(age) || age < 21) {
      return { status: { responseCode: '1', errorCode: 'INVALID_DOB', errorDesc: 'Applicant must be at least 21 years old.' } };
    }
  }

  // Failure scenario: mobile 9999999999 simulates "no offer available" error response
  if (mobileNo === '9999999999') {
    return {
      contextParam: { ...JOURNEY_CONTEXT },
      responseString: { offerAvailable: 'N', existingCustomer: 'N' },
      status: {
        responseCode: '1',
        errorCode: 'NO_OFFER',
        errorDesc: 'No pre-approved offer found for this customer.',
      },
    };
  }

  // Generate a random OTP and store it so the OTP page can pre-fill and validate it
  const mobileOtp = String(Math.floor(100000 + Math.random() * 900000));
  sessionStorage.setItem('mobileOtp', mobileOtp);

  // Success scenario (happy path)
  const mockResponse = {
    contextParam: {
      ...JOURNEY_CONTEXT,
      bankJourneyID: '20211601234567890',
    },
    responseString: {
      offerAvailable: 'Y',
      existingCustomer: 'Y',
    },
    status: { responseCode: '0', errorCode: '', errorDesc: '' },
  };

  sessionStorage.setItem('bankJourneyID', mockResponse.contextParam.bankJourneyID);
  sessionStorage.setItem('partnerJourneyID', JOURNEY_CONTEXT.partnerJourneyID);

  return mockResponse;
}

/**
 * API 2: VerifyOTPAndGetDemogDetails (mocked)
 * OTP "123456" succeeds; anything else returns an error
 */
export async function verifyOTPAndGetDemogDetails(otp) {
  await new Promise((r) => setTimeout(r, 500));

  const expectedMobileOtp = sessionStorage.getItem('mobileOtp');
  if (!expectedMobileOtp || otp !== expectedMobileOtp) {
    return {
      status: { responseCode: '1', errorCode: 'OTP_INVALID', errorDesc: 'Invalid OTP. Please try again.' },
    };
  }

  const mockResponse = {
    contextParam: { ...JOURNEY_CONTEXT, bankJourneyID: sessionStorage.getItem('bankJourneyID') },
    responseString: {
      OfferDemogDetails: [{
        customerFirstName: 'Ankit',
        customerMiddleName: '',
        customerLastName: 'Enterprises',
        customerAddress1: '1301, Barkha',
        customerAddress2: 'Opposite Brigh School, Village Road',
        customerCity: 'Mumbai',
        customerState: 'Maharashtra',
        zipCode: '400016',
        customerCountry: 'India',
        emailAddress: 'ankit@gmail.com',
        customerMobileNo: '98709212345',
        dateOfBirth: '01/01/1985',
        maskedPan: '***** *234 Z',
        employerName: 'Apollo Services',
        residenceType: 'Owned by Parents',
        offerAmount: '1000000.00',
        tenure: '36',
        rateOfInterest: '10.20',
        processingFee: '3000.00',
        typeOfLoan: 'Fresh Loan',
        kycFlag: 'Y',
        accountNumber: 'XX50151',
        customerID: 'XX12345',
      }],
    },
    status: { responseCode: '0', errorCode: '', errorDesc: '' },
  };

  // Store offer data — no PII in key names visible in logs
  sessionStorage.setItem('offerDemogDetails', JSON.stringify(
    mockResponse.responseString.OfferDemogDetails[0],
  ));

  return mockResponse;
}

/**
 * API 3: Generate Email OTP (mocked)
 * Sends OTP to the supplied email address.
 */
export async function generateEmailOTP(email) {
  await new Promise((r) => setTimeout(r, 400));
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: { responseCode: '1', errorCode: 'INVALID_EMAIL', errorDesc: 'Invalid email address.' } };
  }
  const emailOtp = String(Math.floor(100000 + Math.random() * 900000));
  sessionStorage.setItem('emailOtp', emailOtp);
  sessionStorage.setItem('pendingEmailOtpFor', email);
  return { status: { responseCode: '0', errorCode: '', errorDesc: '' } };
}

/**
 * API 4: Validate Email OTP (mocked)
 * OTP "123456" always succeeds for any email.
 */
export async function validateEmailOTP(email, otp) {
  await new Promise((r) => setTimeout(r, 400));
  const expectedEmailOtp = sessionStorage.getItem('emailOtp');
  if (!expectedEmailOtp || otp !== expectedEmailOtp) {
    return { status: { responseCode: '1', errorCode: 'OTP_INVALID', errorDesc: 'Invalid email OTP. Please try again.' } };
  }
  return { status: { responseCode: '0', errorCode: '', errorDesc: '' } };
}

/**
 * API 5: PAN Enquiry (mocked)
 * Validates PAN and returns name on record.
 */
export async function performPANEnquiry(panNo) {
  await new Promise((r) => setTimeout(r, 500));
  if (!panNo || !/^[A-Z]{5}\d{4}[A-Z]$/.test(panNo)) {
    return { status: { responseCode: '1', errorCode: 'INVALID_PAN', errorDesc: 'Invalid PAN format.' } };
  }
  return {
    responseString: { firstName: 'Ankit', middleName: '', lastName: 'Enterprises', panStatus: 'VALID' },
    status: { responseCode: '0', errorCode: '', errorDesc: '' },
  };
}

/**
 * API 6: Get Bureau Offer (mocked)
 * Returns a bureau-sourced loan offer based on customer profile.
 */
export async function getBureauOffer(customerData) {
  await new Promise((r) => setTimeout(r, 600));
  const jid = sessionStorage.getItem('partnerJourneyID') ?? 'unknown';
  sessionStorage.setItem('bureauOfferFetched', `${jid}:${Date.now()}`);
  return {
    responseString: {
      offerAmount: '1000000.00',
      tenure: '36',
      rateOfInterest: '10.20',
      processingFee: '3000.00',
      salaryAccountNumber: '123456789011',
      ifscCode: 'ICIC10000001',
      bankName: 'ICICI Bank',
    },
    status: { responseCode: '0', errorCode: '', errorDesc: '' },
  };
}

/**
 * API 7: Submit Loan Application (mocked)
 */
export async function submitLoanApplication(loanData) {
  await new Promise((r) => setTimeout(r, 800));

  const mockResponse = {
    contextParam: { ...JOURNEY_CONTEXT },
    responseString: {
      vkycLink: '',
      acknowledgementId: `14${Math.floor(Math.random() * 9000000 + 1000000)}`,
    },
    status: { responseCode: '0', errorCode: '', errorDesc: '' },
  };

  sessionStorage.setItem('submissionResult', JSON.stringify(mockResponse.responseString));

  return mockResponse;
}
