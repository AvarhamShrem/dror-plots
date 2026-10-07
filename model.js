// לוגיקת הכלי — ללא DOM, כדי שאפשר לבדוק ב-node (test_model.js)

// קטגוריות מחיר לפי חוברת המכרז סע' 8.10. מפתח = שדה ב-p.prices
const CATEGORIES = [
  { key: 'res_home', label: 'חייל מילואים פעיל / לוחם — מחוסר דיור', reservist: true },
  { key: 'res', label: 'חייל מילואים פעיל / לוחם — לא מחוסר דיור', reservist: true },
  { key: 'pub_home', label: 'כלל הציבור — מחוסר דיור' },
  { key: 'pub', label: 'כלל הציבור — לא מחוסר דיור' },
];
const catKey = s => {
  const cat = CATEGORIES.find(c => c.key === s.category) || CATEGORIES[0];
  return cat.key + (cat.reservist && !s.use35 ? '_no35' : '');
};
const priceOf = (p, s) => p.prices[catKey(s)];

// 297 זוכים (קדימות 1–297); רשימת ההמתנה בוחרת אחריהם (19/10)
const WINNERS = 297;
const absPos = s => (s.waiting ? WINNERS + s.pos : s.pos);

// קריטריונים לדירוג אישי. hb = higher-is-better.
// נתון חדש לכל מגרש → שדה ב-build.py ושורה כאן
const CRITERIA = [
  { key: 'area', label: 'שטח גדול', val: p => p.area, hb: true },
  { key: 'price', label: 'מחיר כולל נמוך', val: priceOf, hb: false },
  { key: 'ppm', label: 'מחיר למ"ר נמוך', val: (p, s) => priceOf(p, s) / p.area, hb: false },
  { key: 'type', label: 'סוג מגרש מועדף', val: (p, s) => (p.type === s.prefType ? 1 : 0), hb: true },
  { key: 'hood', label: 'שכונה מועדפת', val: (p, s) => (p.hood === s.prefHood ? 1 : 0), hb: true },
  { key: 'elev', label: 'מגרש גבוה (לפי מפת גבהים לפני פיתוח)', val: p => p.elev, hb: true, needs: 'elev' },
  { key: 'slope', label: 'שיפוע המגרש לפני פיתוח', val: p => p.slope, hb: s => s.prefSlope === 'sloped', needs: 'slope' },
].filter(c => !c.needs || (typeof window !== 'undefined' && window.PLOTS && window.PLOTS[0][c.needs] !== undefined));

function normalizer(vals, hb) {
  const mn = Math.min(...vals), mx = Math.max(...vals);
  return v => (mx === mn ? 1 : (hb ? v - mn : mx - v) / (mx - mn));
}

// זוכים שבוחרים לפניך (עובדה מרשימת הזוכים; רשימת ההמתנה אחרי כל 297)
const waitingBefore = s => Math.max(0, absPos(s) - 1);

// דירוג עובדתי: 1 + מספר המגרשים ש"טובים" ממנו בתכונה (שוויון = אותו דירוג)
const rankBy = (all, val, better) => p => 1 + all.filter(q => better(val(q), val(p))).length;

function enrich(plots, s) {
  const taken = new Set(s.taken || []);
  const active = s.order.filter(k => s.enabled[k]);
  const hb = c => (typeof c.hb === 'function' ? c.hb(s) : c.hb);
  const norms = Object.fromEntries(CRITERIA.map(c => [c.key, normalizer(plots.map(p => c.val(p, s)), hb(c))]));
  const crit = Object.fromEntries(CRITERIA.map(c => [c.key, c]));
  const wsum = active.reduce((a, _, i) => a + (active.length - i), 0);
  const areaRank = rankBy(plots, p => p.area, (a, b) => a > b);
  const priceRank = rankBy(plots, p => priceOf(p, s), (a, b) => a < b);
  const groups = {};
  for (const p of plots) (groups[p.hood + p.type] ||= []).push(p);
  return plots.map(p => {
    const score = wsum
      ? active.reduce((a, k, i) => a + (active.length - i) * norms[k](crit[k].val(p, s)), 0) / wsum
      : 0;
    const g = groups[p.hood + p.type];
    return {
      ...p,
      price: priceOf(p, s),
      penalty: p.penalties[catKey(s)],
      ppm: Math.round(priceOf(p, s) / p.area),
      taken: taken.has(p.id),
      areaRank: areaRank(p),                                           // 1 = הגדול ביותר מ-297
      groupRank: rankBy(g, q => q.area, (a, b) => a > b)(p), groupSize: g.length,  // בשכונה+סוג
      priceRank: priceRank(p),                                         // 1 = הזול ביותר
      score: Math.round(score * 100),
    };
  });
}

// טווחים: שדה בהגדרות → [שדה במגרש, 1 = מינימום / -1 = מקסימום]. 0 / ריק = בלי הגבלה.
const RANGES = {
  minPrice: ['price', 1], budget: ['price', -1], minArea: ['area', 1], maxArea: ['area', -1],
  maxPpm: ['ppm', -1], maxPenalty: ['penalty', -1], minElev: ['elev', 1], maxSlope: ['slope', -1], maxDrop: ['drop', -1],
};
// מול הרחוב: עד מטר לכל כיוון = מישורי
const riseDir = p => (p.rise === undefined ? undefined : p.rise > 1 ? 'up' : p.rise < -1 ? 'down' : 'flat');

function passes(p, s) {
  return s.hoods.includes(p.hood) && s.types.includes(p.type)
    && Object.entries(RANGES).every(([k, [f, d]]) => !s[k] || p[f] === undefined || (d > 0 ? p[f] >= s[k] : p[f] <= s[k]))
    && (!s.edges || p.edge === undefined || s.edges.includes(p.edge))
    && (!s.rises || s.rises.length === 3 || s.rises.includes(riseDir(p)));  // סינון כיוון פעיל → מגרש בלי חזית מזוהה לא עובר
}

// הצעות = K (+extra) המגרשים עם הציון האישי הגבוה ביותר שעוברים את הסינון ולא נבחרו.
// מגרשים שכבר בפול (pinned) או הוסתרו (excluded) לא מוצעים — וההצעות מתמלאות מחדש.
function buildPool(rows, s) {
  const skip = new Set([...(s.pinned || []), ...(s.excluded || [])]);
  const cand = rows.filter(p => !p.taken && passes(p, s)).sort((a, b) => b.score - a.score || a.priceRank - b.priceRank);
  const pool = cand.filter(p => !skip.has(p.id)).slice(0, s.k + (s.extra || 0));
  return { pool, candidates: cand.length };
}

// מגרשים דומים — להרחבת הפול מנקודת מוצא: אותה שכונה ואותו סוג, שטח עד ±15%,
// מדורג לפי הפרש שטח + הפרש מחיר (יחסיים) + קנס קטן אם המיקום ביישוב שונה. לא כולל שנבחרו.
function similar(p, rows, n = 4) {
  return rows
    .filter(q => q.id !== p.id && !q.taken && q.hood === p.hood && q.type === p.type && Math.abs(q.area - p.area) / p.area <= 0.15)
    .map(q => ({ q, d: Math.abs(q.area - p.area) / p.area + Math.abs(q.price - p.price) / p.price + (q.edge !== p.edge ? 0.1 : 0) }))
    .sort((a, b) => a.d - b.d).slice(0, n).map(x => x.q);
}

if (typeof module !== 'undefined') module.exports = { CATEGORIES, CRITERIA, absPos, waitingBefore, enrich, buildPool, similar, passes, riseDir };
