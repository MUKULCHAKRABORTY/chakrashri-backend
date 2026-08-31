/**
 * Category and badge normalisation — #21.
 *
 * The problem being solved: these are free-text fields typed by an admin, so
 * "Malas", "malas", "MALAS" and " Malas " all arrived as different values and
 * showed up as four separate categories in the shop filter for what is
 * obviously one category.
 *
 * Rule: STORE a canonical lowercase form, DISPLAY a title-cased form. Storing
 * lowercase (rather than storing whatever was typed and comparing
 * case-insensitively) means the uniqueness is a property of the data itself,
 * so it holds no matter which endpoint writes it.
 */

/**
 * Canonical stored form: trimmed, internal whitespace collapsed, lowercased.
 * Returns null for empty input so an empty badge is NULL rather than '' —
 * those look identical to a human but filter and sort differently.
 */
function normaliseTerm(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim().toLowerCase();
  return cleaned === '' ? null : cleaned;
}

/**
 * Display form: "puja samagri kits" -> "Puja Samagri Kits".
 * Small connecting words stay lowercase unless they lead, which is what reads
 * naturally in a category name ("Idols and Murtis", not "Idols And Murtis").
 */
const MINOR_WORDS = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'for', 'in', 'on', 'with', 'to']);

function displayTerm(value) {
  const cleaned = normaliseTerm(value);
  if (!cleaned) return '';
  // Cased per hierarchy segment, so a future "books/scripture" reads correctly
  // and matches catLabel() in index.html exactly. See the note there.
  return cleaned
    .split('/')
    .map((segment) =>
      segment
        .trim()
        .split(' ')
        .filter(Boolean)
        .map((word, i) => {
          if (i > 0 && MINOR_WORDS.has(word)) return word;
          // Preserve inner punctuation like "murtis & idols" or "5-mukhi"
          return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ')
    )
    .filter(Boolean)
    .join('/');
}

module.exports = { normaliseTerm, displayTerm };
