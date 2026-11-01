/**
 * Screening of text that is about to be remembered, or is about to be replayed into a prompt: is it a secret, how private is
 * it, and is it an instruction aimed at the model rather than a fact about the user? Pure functions over strings; never
 * throw; bounded work (a text longer than MAX_SCAN is cut before any pattern runs).
 *
 * What these are: a conservative, best-effort FILTER, the last line of defence behind the user's own judgement and the
 * approval card the memory tool already asks for. They err towards "private" (kept out of anything sent to the cloud) and
 * towards refusing a secret; a false positive costs one refused or hidden note, a false negative leaks. They do not read
 * meaning: a determined writer can always paraphrase a fact until no keyword matches, which is why the digest also quotes
 * every note as data (see CharacterMemory.digest).
 */
import type { Sensitivity } from '@ai-assistant/shared'

/**
 * A text is judged on its first MAX_SCAN characters: the memory cuts notes to 600 before it asks, and a direct call with a
 * huge string must stay cheap (some patterns are quadratic in the text length: about 15 ms at this size).
 */
export const MAX_SCAN = 2000

/**
 * The form the detectors read: NFKC (fullwidth letters and digits, ligatures and other compatibility forms fold to plain
 * ones), invisible and control characters removed (a zero-width space inside "dep​ression" does not hide it) and
 * whitespace collapsed.
 */
export function plainForm(text: unknown): string {
  if (typeof text !== 'string') return ''
  const cut = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text
  let s = cut
  try {
    s = cut.normalize('NFKC')
  } catch {
    // normalize never throws for a string; keep the raw text if some engine disagrees
  }
  return s
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\t' || c === '\n' || c === '\r' || c === ' ' || c === ' ' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** `stem*` means the stem followed by any letters (so non-ASCII word endings work); everything else is a regex fragment. */
const alternation = (terms: readonly string[]): string => terms.map((t) => (t.endsWith('*') ? `${t.slice(0, -1)}\\p{L}*` : t)).join('|')
/** Whole-word matcher (Unicode-aware boundaries, case-insensitive). */
const words = (terms: readonly string[]): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation(terms)})(?![\\p{L}\\p{N}_])`, 'iu')

// ------------------------------------------------------------------------------------------------------ secrets

const PASSWORD_WORDS =
  'password|passwd|pwd|passphrase|passcode|pass code|passwort|kennwort|contrase(?:ñ|n)a|clave|mot de passe|mdp|senha|palavra[- ]passe|wachtwoord|l(?:ö|o)senord|salasana|hasło|heslo|jelszó|şifre|пароль|كلمة السر|كلمة المرور'
const PASSWORD_WORDS_CJK = '密码|密碼|口令|パスワード|암호|비밀번호'
/** Words that name a one-time or short code; the value after them must contain a digit. */
const CODE_WORDS =
  'pin(?: code| number)?|otp|cvv2?|cvc2?|cvn|security code|verification code|confirmation code|authenticat(?:ion|or) code|(?:2fa|mfa|two[- ]factor|one[- ]time) (?:code|password|passcode|pin)|access code|unlock code|door code|gate code|alarm code|safe combination|(?:recovery|backup|reset|activation) (?:codes?|keys?)'
const ID_WORDS =
  "ssn|social security(?: number| no\\.?)?|national insurance(?: number)?|nino|tax (?:id|number)|passport(?: number| no\\.?)?|(?:driver'?s?|driving) licen[cs]e(?: number| no\\.?)?|(?:bank )?account(?: number| no\\.?)|routing number|sort code|iban|swift|card number"

const SECRET_PATTERNS: readonly RegExp[] = [
  // vendor key shapes
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bpypi-[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bya29\.[0-9A-Za-z_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\bkey-[0-9a-f]{32}\b/,
  /\bSK[0-9a-f]{32}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  // webhooks, credentials inside URLs, tokens in query strings
  /hooks\.slack\.com\/services\/[A-Za-z0-9/]{10,}/i,
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{10,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /[?&#;](?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|key|secret|client[_-]?secret|sig|signature|password|passwd|pwd|auth|session|sid|code|otp|jwt|bearer)=[^\s&#]{8,}/i,
  // a value labelled as a password (any language)
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${PASSWORD_WORDS})(?![\\p{L}\\p{N}_])\\s*(?:is|are|was|ist|es|est|är|:|：|=|-|–|—)?\\s*[:=：]?\\s*\\S{6,}`, 'iu'),
  new RegExp(`(?:${PASSWORD_WORDS_CJK})\\s*(?:是|は|:|：|=)?\\s*\\S{4,}`, 'u'),
  // a value labelled secret/token/key must look like one (a digit or a symbol, 8+ characters)
  /(?<![\p{L}\p{N}_])(?:secret|token|bearer|api[_ -]?key|access[_ -]?key|private[_ -]?key|client[_ -]?secret)(?![\p{L}\p{N}_])\s*(?:is|are|:|=|-)?\s*[:=]?\s*(?=\S*[\d_+/=!@#$%^&*-])\S{8,}/iu,
  /\b[\w-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key)s?\s*[:=]\s*["']?[^\s"']{6,}/i,
  // PINs, one-time codes, recovery codes: the code is the part with digits in it
  new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${CODE_WORDS})(?![\\p{L}\\p{N}_])(?:\\s+(?:is|are|was|will be|=|:|-|–|—))?\\s*[:=#-]?\\s*(?=[A-Za-z0-9-]*\\d)[A-Za-z0-9][A-Za-z0-9-]{2,23}(?![\\p{L}\\p{N}_])`,
    'iu',
  ),
  // a seed / recovery phrase: the label followed by a run of words
  /(?<![\p{L}\p{N}_])(?:seed|mnemonic|wallet|secret recovery|recovery)[ -](?:phrase|words|seed)(?![\p{L}\p{N}_])\s*(?:is|are|was|:|=|-|–|—)?\s*(?:[a-z]{3,9}\s+){5,}[a-z]{3,9}\b/iu,
  /\b(?:12|24|twelve|twenty[- ]four)[- ]words?\b[^.!?]{0,30}\b(?:seed|phrase|recovery|wallet|mnemonic)\b/i,
  // identity and account numbers: the label then a long digit run
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${ID_WORDS})(?![\\p{L}\\p{N}_])[^\\d\\n]{0,10}[A-Za-z]{0,2}\\d(?:[ -]?\\d){5,}`, 'iu'),
  /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/, // US social security number shape
  // long opaque strings: hex digests and keys, base64 blobs
  /\b[0-9a-f]{32,}\b/i,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$)/,
]

function luhnOk(digits: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

/** A 13..19 digit run (spaces or hyphens between digits allowed) that passes the Luhn check and starts like a card scheme. */
function hasCardNumber(s: string): boolean {
  for (const m of s.matchAll(/(?<![\d+.])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length < 13 || digits.length > 19) continue
    if (!/^[2-6]/.test(digits)) continue
    if (new Set(digits).size < 2) continue // all the same digit is a placeholder, not a card
    if (luhnOk(digits)) return true
  }
  return false
}

/** ISO 13616 check: country, check digits, up to 30 more characters, mod 97 equals 1. */
function hasIban(s: string): boolean {
  for (const m of s.matchAll(/(?<![\p{L}\p{N}])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?(?![\p{L}\p{N}])/gu)) {
    const t = m[0].replace(/ /g, '').toUpperCase()
    if (t.length < 15 || t.length > 34) continue
    const re = t.slice(4) + t.slice(0, 4)
    let rem = 0
    let valid = true
    for (let i = 0; i < re.length; i++) {
      const c = re.charCodeAt(i)
      const v = c >= 65 && c <= 90 ? c - 55 : c - 48
      if (v < 0 || v > 35) {
        valid = false
        break
      }
      rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97
    }
    if (valid && rem === 1) return true
  }
  return false
}

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** A mixed-case, digit-bearing token of 28+ characters with high entropy and few separators: an API key or similar. */
function hasRandomToken(s: string): boolean {
  for (const m of s.matchAll(/[A-Za-z0-9_-]{28,}/g)) {
    const t = m[0]
    if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/\d/.test(t)) continue
    if ((t.match(/[-_]/g) ?? []).length > 2) continue
    if (entropy(t) >= 4.2) return true
  }
  return false
}

/** True for API keys, tokens, private keys, passwords (any language), PINs and codes, seed phrases, card, IBAN and identity numbers. */
export function looksLikeSecret(text: string): boolean {
  const s = plainForm(text)
  if (s.length === 0) return false
  return SECRET_PATTERNS.some((p) => p.test(s)) || hasCardNumber(s) || hasIban(s) || hasRandomToken(s)
}

// ------------------------------------------------------------------------------------------------- sensitivity

/** Special categories and money: intimate life, sexuality, health, finances, legal trouble. */
const SENSITIVE_WORDS = words([
  // intimate life and sexuality
  'intimate',
  'intimacy',
  'kiss(?:ed|ing|es)?',
  'romantic*',
  'romance',
  'sexual*',
  'sex',
  'sexy',
  'naked',
  'nude*',
  'porn*',
  'erotic*',
  'fetish*',
  'orgasm*',
  'masturbat*',
  'love you',
  'in love',
  'girlfriend',
  'boyfriend',
  'affair with',
  '(?:having|had|has) an affair',
  'cheat(?:ed|ing|s)? on',
  'one[- ]night stand',
  'hook(?:ed)?[- ]?up',
  '(?:am|is|are|was|were|been|started|stopped|keeps?|kept) dating',
  'dating (?:app|site|profile|someone|a|an|her|him|them)',
  'fianc*',
  'sexuality',
  'sexual orientation',
  'gay',
  'lesbian',
  'bisexual',
  'transgender',
  'trans (?:man|woman|person|people)',
  'non[- ]?binary',
  'queer',
  'asexual',
  'pansexual',
  'homosexual*',
  'lgbt*',
  '(?:came|coming) out (?:as|to (?:my|his|her|their) (?:family|parents|friends))',
  'gender identity',
  // health
  'diagnos*',
  'therap*',
  'psychiatr*',
  'psycholog*',
  'depress*',
  'anxiety',
  'anxious',
  'panic attack',
  'medicat*',
  'prescri(?:ption|bed|be|bing)',
  'suicid*',
  'self[- ]harm',
  'abus(?:e|ed|es|ive)',
  'pregnan*',
  'cancer',
  'tumou?r',
  'chemo*',
  'hiv',
  'hiv/aids',
  'aids (?:patient|diagnosis|positive|test|status)',
  'herpes',
  'hepatitis',
  'chlamydia',
  'gonorrh*',
  'syphilis',
  'diabet*',
  'insulin',
  'asthma*',
  'epilep*',
  'seizure*',
  'bipolar',
  'schizo*',
  'adhd',
  'autis*',
  'ocd',
  'ptsd',
  'anorex*',
  'bulimi*',
  'eating disorder',
  'mental health',
  'burn[- ]?out',
  'disorder',
  'syndrome',
  'chronic',
  'illness',
  'disease',
  'surger*',
  'migraine*',
  'stroke',
  'dementia',
  'alzheimer*',
  'parkinson*',
  'arthritis',
  'lupus',
  'crohn*',
  'allerg*',
  'rehab',
  'addict*',
  'alcoholi*',
  'sobriety',
  'relapse',
  'overdose',
  'opioid*',
  'antidepress*',
  'ssri',
  'lithium',
  'xanax',
  'prozac',
  'zoloft',
  'ritalin',
  'adderall',
  'benzo*',
  'miscarriage',
  'abortion',
  'fertility',
  'ivf',
  'menopause',
  'menstrua*',
  'covid*',
  'symptom*',
  'blood pressure',
  'cholesterol',
  'disabilit*',
  'wheelchair',
  // money
  'salary',
  'salaries',
  'income',
  'net worth',
  'savings',
  'debt*',
  'loan*',
  'owe[sd]?',
  'owing',
  'bankrupt*',
  'mortgage*',
  'credit (?:card|score|limit)',
  'debit card',
  'bank account',
  'bank balance',
  'account balance',
  'iban',
  'routing number',
  'sort code',
  'wire transfer',
  'tax(?:es)? return',
  'tax id',
  'payroll',
  'paycheck',
  'pay ?cheque',
  'wages?',
  'severance',
  'pension',
  'inheritance',
  'cryptocurrenc*',
  'crypto (?:wallet|portfolio|holdings|investments?|trading|exchange)',
  'bitcoin',
  'ethereum',
  'investment*',
  'stock options',
  'dividend*',
  'overdraft',
  'alimony',
  'child support',
  // legal trouble and status
  'lawsuit*',
  'lawyer*',
  'attorney*',
  'sued',
  'suing',
  'sue (?:him|her|them|us|me|the)',
  'court (?:case|date|hearing|order|appearance)',
  'in court',
  'arrest*',
  'convict*',
  'criminal',
  'prison',
  'jail*',
  'probation',
  'parole',
  'felony',
  'misdemeanou?r',
  'restraining order',
  'custody',
  'divorce*',
  'immigration',
  'visa',
  'asylum',
  'deport*',
  'green card',
  'undocumented',
  'subpoena*',
])

/** People close to her, where she lives, how to reach her, belief and politics: kept out of the cloud, but not "intimate". */
const PRIVATE_WORDS = words([
  'family',
  'mother',
  'father',
  'mom',
  'mum',
  'dad',
  'brother',
  'sister',
  'son',
  'daughter',
  'wife',
  'husband',
  'parents?',
  'grand(?:mother|father|ma|pa|parents?)',
  'granny',
  'aunt',
  'uncle',
  'cousin',
  'nephew',
  'niece',
  'kids?',
  'child(?:ren)?',
  'baby',
  'spouse',
  '(?:my|his|her|their|our) partner',
  'ex[- ]?(?:wife|husband|boyfriend|girlfriend|partner)',
  'in-laws?',
  'step(?:mother|father|son|daughter|child\\p{L}*)',
  'godmother',
  'godfather',
  'home address',
  'address',
  'street',
  'zip ?code',
  'postal code',
  'post ?code',
  'apartment',
  'flat number',
  'neighbou?rhood',
  'lives? (?:in|at|on|near)',
  'hometown',
  'home ?town',
  'birthday',
  'birth ?date',
  'date of birth',
  'dob',
  'born (?:on|in)',
  '\\d{1,3}[- ]years?[- ]old',
  'aged \\d{1,3}',
  'turns? (?:1[89]|[2-9]\\d)',
  'phone number',
  'mobile number',
  'cell number',
  'telephone',
  'e-?mail address',
  '(?:my|his|her|their|our) (?:e-?mail|phone|mobile|cell(?:phone)?|number)',
  'health',
  'doctor*',
  'hospital*',
  'dentist',
  'clinic',
  'religio*',
  'church',
  'mosque',
  'synagogue',
  'pray*',
  'faith',
  'atheis*',
  'christian*',
  'muslim*',
  'islam*',
  'jewish',
  'judaism',
  'hindu*',
  'buddhis*',
  'catholic*',
  'protestant*',
  'sikh*',
  'politic*',
  'vote[ds]?',
  'voting',
  'election*',
  'democrat*',
  'republican*',
  'left-wing',
  'right-wing',
  'trade union',
  'union member',
  'party member',
  'racial*',
  'ethnic*',
  '(?:my|his|her|their) race',
  'nationality',
  'passport',
])

/** Shapes that are private whatever the words around them are. */
const PRIVATE_SHAPES: readonly RegExp[] = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u, // an email address
  /\b(?:https?|ftp|ssh|file):\/\/\S+|\bwww\.\S+/i, // a link
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // an IPv4 address
  /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i, // a MAC address
  /-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/, // coordinates
  /(?<![\d-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{3,4}(?![\d-])/, // a phone number with grouping
  /(?<![\d.])\+\d{8,15}(?!\d)/, // an international number without grouping
  /\b(?:phone|mobile|cell|tel|telephone|call me|text me)\b[^\n]{0,24}?\d[\d ().+-]{6,}\d/i,
  /(?<![\d.,-])\d{9,}(?!\d)/, // nine or more digits in a row: account, order, id and card-like numbers
  /(?<![\d.,-])\d{4}(?:[ -]\d{4}){2,}(?![\d-])/, // digits grouped by four, like an account or card number
  /\b\d{1,5} (?:\p{Lu}[\p{L}'.-]* ){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Square|Sq|Terrace|Crescent|Close|Strasse|Straße)\b\.?/u, // 12 Baker Street
  /\b[A-Z]{1,2}\d[A-Z\d]?[ ]?\d[A-Z]{2}\b/, // a UK postcode
  /(?<![\d-])\d{5}-\d{4}(?![\d-])/, // a US ZIP+4
]

/** Money amounts and rates: a currency sign next to a number, a number with a currency word, "90k a year". */
const MONEY_SHAPES: readonly RegExp[] = [
  /[$€£¥₹₩₽₺₪฿]\s?\d|\d\s?[$€£¥₹₩₽₺₪฿]/u,
  /\d[\d.,]*\s?(?:k|m|mm|bn|b|million|billion|thousand|grand)?\s?(?:usd|eur|gbp|chf|cad|aud|jpy|inr|dollars?|euros?|pounds?|quid|bucks|yen|pesos?|rupees?|francs?)\b/i,
  /\b\d+(?:\.\d+)?\s?k\s+(?:a|per)\s+(?:year|month|yr|mo)\b/i,
]

const ORDER: Record<Sensitivity, number> = { normal: 0, private: 1, sensitive: 2 }
export const stricterSensitivity = (a: Sensitivity, b: Sensitivity): Sensitivity => (ORDER[a] >= ORDER[b] ? a : b)

/**
 * Conservative classifier. The caller can only make an item stricter than this, never looser. Matching reads the NFKC form
 * with invisible characters removed, so zero-width splits and fullwidth letters do not hide a word.
 */
export function classifySensitivity(text: string): Sensitivity {
  const s = plainForm(text)
  if (s.length === 0) return 'normal'
  if (SENSITIVE_WORDS.test(s) || MONEY_SHAPES.some((p) => p.test(s))) return 'sensitive'
  if (PRIVATE_WORDS.test(s) || PRIVATE_SHAPES.some((p) => p.test(s))) return 'private'
  return 'normal'
}

// ------------------------------------------------------------------------------------------------- instructions

/**
 * Text that reads as an instruction to the model rather than a fact about the user: chat-template and role markers,
 * "ignore the previous rules", sending things somewhere, hiding things from the user, jailbreak framings, shell
 * one-liners, markup that exfiltrates. Ordinary style preferences ("keep it short", "don't use emojis") are NOT matched.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // chat-template tokens and tags aimed at the model
  /<\|[^|>]{1,40}\|>|\[\/?INST\]|<<\/?SYS>>/i,
  /<\/?\s*(?:system|assistant|developer|instructions?|prompt|tool_?calls?|function_?calls?|scratchpad|thinking)\b[^>]{0,60}>/i,
  // a role label at the start of the text or of a sentence: "SYSTEM NOTE: ...", "Assistant: ..."
  /(?:^|[.!?;:)\]}>"'])\s*[[({<#*_ ]{0,4}(?:system|developer|assistant)\b(?:\s+(?:note|message|prompt|instructions?|override|update|alert|notice|command|directive))?\s*[\])}>*_ ]{0,3}\s*[:>\]]/i,
  /\b(?:instructions?|directives?|system prompt) (?:for|to) (?:the )?(?:assistant|ai|model|bot|claude)\b/i,
  /\bnote to (?:the )?(?:assistant|ai|model|bot|claude)\b/i,
  /\b(?:new|updated|revised|real|actual|hidden)\s+(?:instructions?|system prompt|directives?)\b/i,
  // overriding earlier rules
  /\b(?:ignore|disregard|forget|override|overrule|bypass|circumvent)\b[^.!?\n]{0,40}?\b(?:all|any|every|previous|prior|earlier|above|preceding|former|your|these|those|system|safety|security|existing|original|initial|core|built-in|hidden)\b[^.!?\n]{0,40}?\b(?:instructions?|rules?|prompts?|guidelines?|polic(?:y|ies)|constraints?|restrictions?|directives?|safeguards?|guardrails?|programming)\b/i,
  /\b(?:ignore|disregard)\b[^.!?\n]{0,20}\b(?:above|previous|prior|earlier|preceding)\b/i,
  /\bfrom now on\b[^.!?\n]{0,30}\b(?:you|ignore|disregard|never|always)\b/i,
  // sending things somewhere
  /\b(?:e-?mail|send|forward|upload|post|leak|exfiltrat\w*|transmit|dm|text|fax|copy|paste|share|publish|submit|sync|attach|dump|export)\b[^.!?\n]{0,60}\b(?:to|at|into|onto|via|through)\b[^.!?\n]{0,60}(?:[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:com|net|org|io|ru|cn|xyz|tk|ly|me|co|app|dev|sh)\b)/i,
  /\b(?:e-?mail|send|forward|upload|post|leak|exfiltrat\w*|transmit|dump|export|reveal|disclose|print|output|repeat|recite|read out)\b[^.!?\n]{0,40}?\b(?:the |my |your |all )?(?:vault|keychain|credentials|system prompt|hidden prompt|initial prompt|your prompt|your instructions|these instructions|instructions above|prompt above)\b/i,
  // hiding things from the user
  /\b(?:do not|don't|dont|never|without)\b[^.!?\n]{0,15}\b(?:tell(?:ing)?|inform(?:ing)?|notify(?:ing)?|alert(?:ing)?|warn(?:ing)?|mention(?:ing)?|reveal(?:ing)?|disclos(?:e|ing)|show(?:ing)?)\b[^.!?\n]{0,15}\b(?:the )?user\b/i,
  /\bkeep (?:this|it|that) (?:a )?secret from (?:the )?user\b/i,
  /\bhide (?:this|it|that)\b[^.!?\n]{0,15}\buser\b/i,
  // jailbreak framings
  /\b(?:developer|debug|god|sudo|admin|dan|unrestricted|jailbreak(?:en)?)[ -]?mode\b/i,
  /\bjailbreak\b|\bdo anything now\b/i,
  /\bpretend (?:that )?you (?:are|have|can)\b/i,
  /\bact as (?:an? )?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|different|new|root|admin|system|developer)\b/i,
  /\byou are no longer (?:bound|restricted|limited|an? ai)\b/i,
  /\bno (?:restrictions|filters|rules|limits|guidelines|boundaries)\b[^.!?\n]{0,20}\b(?:apply|anymore|any more|now)\b/i,
  // shell one-liners and markup that exfiltrates
  /\b(?:rm\s+-rf|curl\s+[^\n|]{0,80}\|\s*(?:ba|z)?sh|wget\s+https?:|powershell(?:\.exe)?\s+-|cmd(?:\.exe)?\s*\/c|eval\s*\(|mkfifo|nc\s+-e|bash\s+-i)/i,
  /!\[[^\]]{0,100}\]\(\s*https?:\/\/[^)]{0,300}\)/i,
  /\]\(\s*(?:javascript|data|vbscript):/i,
  /<\s*(?:script|iframe|img|svg|object|embed|link|meta|style)\b/i,
]

/** True when the text reads as an instruction to the model (see INSTRUCTION_PATTERNS). */
export function looksLikeInstruction(text: string): boolean {
  const s = plainForm(text)
  if (s.length === 0) return false
  return INSTRUCTION_PATTERNS.some((p) => p.test(s))
}

// -------------------------------------------------------------------------------------------------------- verdict

export interface Screening {
  secret: boolean
  instruction: boolean
  sensitivity: Sensitivity
}

const cache = new Map<string, Screening>()
const CACHE_MAX = 4096

/** All three judgements for one text, cached (a digest screens every stored item on every call). */
export function screen(text: string): Screening {
  const key = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text
  const hit = cache.get(key)
  if (hit) return hit
  const v: Screening = { secret: looksLikeSecret(key), instruction: looksLikeInstruction(key), sensitivity: classifySensitivity(key) }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, v)
  return v
}
