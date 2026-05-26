// Generate a styled SVG cover for a chapter, in the same visual language
// as the seed ch-2001.svg cover.

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

/**
 * Best-effort: pull a "chapter number" from the title for the large display digit.
 * If no number found, falls back to a short word from the title (max 4 chars).
 */
function extractDisplayMark(englishTitle) {
  const num = englishTitle.match(/\d{1,5}/);
  if (num) return num[0];
  const word = englishTitle.replace(/^chapter\s*/i, "").trim().split(/\s+/)[0] || "";
  return word.slice(0, 4).toUpperCase();
}

/**
 * Render an SVG cover.
 * @param {object} opts { englishTitle, targetTitle }
 * @returns {string} SVG markup.
 */
export function renderCover({ englishTitle, targetTitle }) {
  const mark = extractDisplayMark(englishTitle);
  const englishSub = englishTitle.replace(/^chapter\s*\d+\s*:?\s*/i, "").trim() || englishTitle;
  const targetSub = (targetTitle || "").replace(/^.*?:\s*/, "").trim() || (targetTitle || "");

  // Big number text size: scale down a bit if mark is long
  const markSize = mark.length <= 4 ? 92 : mark.length <= 6 ? 70 : 54;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a2b4a"/>
      <stop offset="55%" stop-color="#2a4878"/>
      <stop offset="100%" stop-color="#0a1428"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="35%" r="55%">
      <stop offset="0%" stop-color="#ffd089" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#ff9a4a" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="600" fill="url(#bg)"/>
  <rect width="400" height="600" fill="url(#glow)"/>
  <line x1="20" y1="380" x2="380" y2="380" stroke="#ffd089" stroke-opacity="0.35" stroke-width="1"/>
  <path d="M 60 540 Q 200 460 340 540" fill="none" stroke="#ffd089" stroke-opacity="0.55" stroke-width="2"/>
  <path d="M 60 560 Q 200 480 340 560" fill="none" stroke="#ffd089" stroke-opacity="0.35" stroke-width="1.5"/>
  <text x="200" y="220" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="800"
        font-size="${markSize}" fill="#ffd089" letter-spacing="6">${escapeXml(mark)}</text>
  <text x="200" y="300" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="700"
        font-size="22" fill="#ffffff">${escapeXml(targetSub.slice(0, 40))}</text>
  <text x="200" y="338" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-style="italic"
        font-size="18" fill="#cfd6e3" opacity="0.85">${escapeXml(englishSub.slice(0, 48))}</text>
</svg>
`;
}
