/**
 * EMI = P × r × (1+r)^n / ((1+r)^n − 1)
 * P = principal, r = monthly rate, n = tenure in months
 */
export function calculateEMI(principal, annualRate, tenureMonths) {
  const r = annualRate / 12 / 100;
  const n = tenureMonths;
  return Math.round((principal * r * (1 + r) ** n) / ((1 + r) ** n - 1));
}

export function formatINR(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}
