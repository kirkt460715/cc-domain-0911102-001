// 十进制字符串的精确换算：value = raw × scale + offset，结果保留三位小数。
// 原始值与系数最长 24 位整数加 12 位小数，乘积超出 double 精度，一律用 BigInt 计算。
// 舍入规则：第 4 位小数恰好处于正中间（以及更大）时，向绝对值更大的方向进位。

const DECIMAL = /^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,12})?$/;

export function parseDecimal(text, label = '十进制数') {
  if (typeof text !== 'string' || !DECIMAL.test(text)) {
    throw new Error(`${label}不是合法十进制字符串：${text}`);
  }
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const digits = dot === -1 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const exp = dot === -1 ? 0 : body.length - dot - 1;
  const mantissa = BigInt(digits) * (negative ? -1n : 1n);
  return { mantissa, exp }; // 值 = mantissa × 10^-exp
}

function align(a, b) {
  const exp = Math.max(a.exp, b.exp);
  return [
    a.mantissa * 10n ** BigInt(exp - a.exp),
    b.mantissa * 10n ** BigInt(exp - b.exp),
    exp,
  ];
}

// 把 mantissa × 10^-exp 舍入到 places 位小数并格式化，正中间向绝对值更大方向。
export function formatRounded({ mantissa, exp }, places) {
  let m = mantissa;
  if (exp > places) {
    const divisor = 10n ** BigInt(exp - places);
    const quotient = m / divisor; // BigInt 除法向零截断
    const remainder = m - quotient * divisor;
    const twice = (remainder < 0n ? -remainder : remainder) * 2n;
    m = twice >= divisor ? quotient + (m < 0n ? -1n : 1n) : quotient;
  } else if (exp < places) {
    m *= 10n ** BigInt(places - exp);
  }
  const negative = m < 0n;
  const digits = (negative ? -m : m).toString().padStart(places + 1, '0');
  const int = places === 0 ? digits : digits.slice(0, -places);
  const frac = places === 0 ? '' : `.${digits.slice(-places)}`;
  return `${negative ? '-' : ''}${int}${frac}`;
}

export function convertRaw(raw, scale, offset) {
  const r = parseDecimal(raw, 'raw');
  const s = parseDecimal(scale, 'scale');
  const o = parseDecimal(offset, 'offset');
  const product = { mantissa: r.mantissa * s.mantissa, exp: r.exp + s.exp };
  const [pm, om, exp] = align(product, o);
  return formatRounded({ mantissa: pm + om, exp }, 3);
}
