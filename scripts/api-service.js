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
  // Tier 1 mock — simulate network latency
  await new Promise((r) => setTimeout(r, 500));

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

  // Persist journey IDs for downstream API calls — no PII stored
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

  if (otp !== '123456') {
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
        offerAmount: '1000000.00',
        tenure: '36',
        rateOfInterest: '10.20',
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
 * API 3: Submit Loan Application (mocked)
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
