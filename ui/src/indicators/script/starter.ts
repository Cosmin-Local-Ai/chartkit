/**
 * The script a new user indicator starts with.
 *
 * It is a working price-action indicator rather than a stub: an average with an
 * ATR-scaled envelope and the band between them, which is enough to show inputs,
 * builtins, two plotted series and a fill on the first load.
 */
export const STARTER_SCRIPT = `// Price-action channel: an average with an ATR-scaled envelope over the tape.
indicator({ name: 'PA Channel', placement: 'price' });

const length = input.int(26, { label: 'Length', min: 1, max: 500 });
const band = input.float(2, { label: 'ATR band', min: 0.1, max: 10, step: 0.1 });
const atrPeriod = input.int(14, { label: 'ATR period', min: 1, max: 200 });
const src = input.source('close');

const mid = ema(src, length);
const envelope = mul(atr(atrPeriod, 'RMA'), band);
const upper = plot('Upper', add(mid, envelope), { color: '#4da3ff', width: 1 });
plot('Mid', mid, { color: '#cbd5e1', width: 1 });
const lower = plot('Lower', sub(mid, envelope), { color: '#4da3ff', width: 1 });
fill(upper, lower, { color: '#4da3ff' });
`;
