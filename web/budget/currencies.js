// Supported currencies: the set Frankfurter (ECB data) publishes, kept static so the app works offline.
export const DEFAULT_BASE = 'JPY';

// code: [symbol, decimal places]
export const CURRENCIES = {
  AUD: ['A$', 2], BGN: ['лв', 2], BRL: ['R$', 2], CAD: ['C$', 2], CHF: ['CHF', 2],
  CNY: ['CN¥', 2], CZK: ['Kč', 2], DKK: ['kr', 2], EUR: ['€', 2], GBP: ['£', 2],
  HKD: ['HK$', 2], HUF: ['Ft', 0], IDR: ['Rp', 2], ILS: ['₪', 2], INR: ['₹', 2],
  ISK: ['kr', 0], JPY: ['¥', 0], KRW: ['₩', 0], MXN: ['MX$', 2], MYR: ['RM', 2],
  NOK: ['kr', 2], NZD: ['NZ$', 2], PHP: ['₱', 2], PLN: ['zł', 2], RON: ['lei', 2],
  SEK: ['kr', 2], SGD: ['S$', 2], THB: ['฿', 2], TRY: ['₺', 2], USD: ['$', 2],
  ZAR: ['R', 2],
};

export const isCurrency = (code) => Object.hasOwn(CURRENCIES, code);
export const currencyCodes = () => Object.keys(CURRENCIES);
export const decimals = (code) => (isCurrency(code) ? CURRENCIES[code][1] : 2);
export const symbol = (code) => (isCurrency(code) ? CURRENCIES[code][0] : code);

// Round half up to `places` decimals, ignoring binary floating point noise (1.005 -> 1.01).
export function roundHalfUp(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(Number((value * factor).toPrecision(12))) / factor + 0;
}

// "¥1,898", "-$12.00"; a dash for anything that is not a finite number.
export function formatMoney(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const places = decimals(code);
  const digits = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
  return `${value < 0 ? '-' : ''}${symbol(code)}${digits}`;
}
