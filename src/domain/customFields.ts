/**
 * Display titles for lead custom fields.
 *
 * Custom field keys come from whichever form posted them, so there is no
 * schema to store titles in. Derive them instead: `projectType`,
 * `project_type`, and `PROJECT_TYPE` all read as "Project Type", and
 * camelCase keeps acronyms (`userID` -> "User ID").
 */

const SPLIT_ACRONYM = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;
const SPLIT_CAMEL = /([\p{Ll}\p{N}])(\p{Lu})/gu;
const SPLIT_LETTER_DIGIT = /(\p{L})(\p{N})/gu;
const SPLIT_DIGIT_LETTER = /(\p{N})(\p{L})/gu;
const SEPARATORS = /[-_.\s]+/gu;
const NON_LETTER = /\P{L}/gu;

const isAllUpper = (word: string): boolean =>
  word === word.toUpperCase() && word !== word.toLowerCase();

const titleWord = (word: string, shouted: boolean): string => {
  // An entirely upper-case key is shouting, not an acronym: `PROJECT_TYPE`
  // reads "Project Type", not "PROJECT TYPE". A single word keeps its
  // upper case because there is nothing to disambiguate it from (`SSN`).
  if (!shouted && word.length > 1 && isAllUpper(word)) {
    return word;
  }

  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
};

export const fieldTitle = (key: string): string => {
  const letters = key.replaceAll(NON_LETTER, '');
  const words = key
    .replaceAll(SPLIT_ACRONYM, '$1 $2')
    .replaceAll(SPLIT_CAMEL, '$1 $2')
    .replaceAll(SPLIT_LETTER_DIGIT, '$1 $2')
    .replaceAll(SPLIT_DIGIT_LETTER, '$1 $2')
    .replaceAll(SEPARATORS, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');

  const shouted = letters !== '' && isAllUpper(letters) && words.length > 1;

  return words.map((word) => titleWord(word, shouted)).join(' ');
};
