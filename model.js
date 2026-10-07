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
  { key: 'slope', label: 'שיפוע המגרש לפני פיתוח (מישורי / משופע)', val: p => p.slope, hb: s => s.prefSlope === 'sloped', needs: 'slope' },
].filter(c => !c.needs || (typeof window !== 'undefined' && window.PLOTS && window.PLOTS[0][c.needs] !== undefined));

function normalizer(vals, hb) {
  const mn = Math.min(...vals), mx = Math.max(...vals);
  return v => (mx === mn ? 1 : (hb ? v - mn : mx - v) / (mx - mn));
}

// מודל הקהל: חד-משפחתי וגדול נבחרים קודם. מחזיר {id: דירוג}, 1 = הכי מבוקש.
function crowdRanks(plots, w) {
  const an = normalizer(plots.map(p => p.area), true);
  const scored = plots.map(p => ({ id: p.id, s: w.type * (p.type === 'חד' ? 1 : 0) + w.area * an(p.area) }));
  scored.sort((a, b) => b.s - a.s);
  const r = {};
  scored.forEach((x, i) => (r[x.id] = i + 1));
  return r;
}

// זוכים שעוד לפניך = מקומך פחות מי שכבר עבר בתור (passed), ואחרי ניכוי מי שלא מגיע
const waitingBefore = s => Math.max(0, absPos(s) - 1 - (s.passed || 0));
const effectiveBefore = s => waitingBefore(s) * (1 - s.noShow);

// שיעור הגעה בפועל מתוך הבחירה שכבר התקיימה: מגרשים שנבחרו / מקומות שעברו
const observedShowRate = s => (s.passed > 0 && s.taken?.length ? Math.min(1, s.taken.length / s.passed) : null);

// סיכוי שמגרש בדירוג rank (בין המגרשים שנשארו) עדיין יהיה פנוי, כש-E בוחרים בפועל לפניך.
// 50% כשהדירוג = E; margin קובע את רוחב אי-הוודאות (בדירוג E±margin·E הסיכוי ~12% / ~88%).
function availability(rank, E, margin) {
  if (E === 0) return 1;
  const k = Math.max(1, margin * E) / 2;
  return 1 / (1 + Math.exp(-(rank - 0.5 - E) / k));
}

function enrich(plots, s) {
  const taken = new Set(s.taken || []);
  const ranks = crowdRanks(plots.filter(p => !taken.has(p.id)), s.crowd);  // דירוג רק בין מה שנשאר
  const E = effectiveBefore(s);
  const active = s.order.filter(k => s.enabled[k]);
  const hb = c => (typeof c.hb === 'function' ? c.hb(s) : c.hb);
  const norms = Object.fromEntries(CRITERIA.map(c => [c.key, normalizer(plots.map(p => c.val(p, s)), hb(c))]));
  const crit = Object.fromEntries(CRITERIA.map(c => [c.key, c]));
  const wsum = active.reduce((a, _, i) => a + (active.length - i), 0);
  return plots.map(p => {
    const score = wsum
      ? active.reduce((a, k, i) => a + (active.length - i) * norms[k](crit[k].val(p, s)), 0) / wsum
      : 0;
    return {
      ...p,
      price: priceOf(p, s),
      penalty: p.penalties[catKey(s)],
      ppm: Math.round(priceOf(p, s) / p.area),
      taken: taken.has(p.id),
      rank: ranks[p.id] ?? null,
      prob: taken.has(p.id) ? 0 : availability(ranks[p.id], E, s.margin),
      score: Math.round(score * 100),
    };
  });
}

function passes(p, s) {
  return s.hoods.includes(p.hood) && s.types.includes(p.type)
    && (!s.budget || p.price <= s.budget) && (!s.minPrice || p.price >= s.minPrice) && (!s.minArea || p.area >= s.minArea)
    && (!s.edges || p.edge === undefined || s.edges.includes(p.edge));
}

// הצעות = K (+extra) מגרשים עם הציון האישי הגבוה ביותר מתוך אלה שסיכוי שיישארו ≥50%,
// ועוד עד 3 "הימורים" (15%–50%) שמדורגים אישית גבוה מההצעה האחרונה.
// מגרשים שהמשתמש כבר הוסיף לפול (pinned) או הסתיר (excluded) לא מוצעים — וההצעות מתמלאות מחדש.
function buildPool(rows, s) {
  const skip = new Set([...(s.pinned || []), ...(s.excluded || [])]);
  const cand = rows.filter(p => !p.taken && passes(p, s)).sort((a, b) => b.score - a.score || b.prob - a.prob);
  const open = cand.filter(p => !skip.has(p.id));
  const pool = open.filter(p => p.prob >= 0.5).slice(0, s.k + (s.extra || 0));
  const floor = pool.length ? pool[pool.length - 1].score : -1;
  const gambles = open.filter(p => p.prob >= 0.15 && p.prob < 0.5 && p.score > floor).slice(0, 3);
  return { pool, gambles, candidates: cand.length };
}

if (typeof module !== 'undefined') module.exports = { CATEGORIES, CRITERIA, absPos, crowdRanks, availability, waitingBefore, effectiveBefore, observedShowRate, enrich, buildPool };
