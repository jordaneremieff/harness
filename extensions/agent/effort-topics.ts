/**
 * Topic terms of an effort: the distinctive words of the text a session already publishes about its
 * work (declared purpose or first request, session name, titles of the items it used). Two sessions
 * share a topic when their term sets share at least MIN_SHARED_TOPICS terms. The rule uses no
 * population statistics, so a result changes only when one of the two sessions changes its own text.
 */

/** Distinct shared terms that make two sessions related by topic. */
export const MIN_SHARED_TOPICS = 2;
/** Shared terms that one comparison reports, in alphabetical order. */
export const SHARED_TOPICS_SHOWN = 8;
/** Terms kept from one effort's text; later text adds nothing once the set is full. */
const MAX_TERMS = 64;
/** Characters of one effort's text that tokenization reads. */
const MAX_TEXT = 4096;

/**
 * English function words, and words that describe agent or engineering work in general rather than
 * its subject. Inflected forms (-s, -es, -ing, -ed) of a listed word are excluded with it.
 */
const STOP_WORDS = `
about above across actually after again against ahead also although always among another anybody anyone anything
anyway anywhere around away back based became because become been before behind being below beside besides
between beyond both brief bring cannot certain change check clear close come complete concern consider continue
could current currently does doing done down during each early either else elsewhere enough even ever every
everyone everything exact example except existing explain fail failing fine first follow following from full
further gave give given going gone good great have having help here into issue item just keep kind know last
later latest least less like likely little look made main make making many maybe mean might mine more most
much must myself near need never next none nothing note noted now okay once only onto open other otherwise
ours ourselves over part perhaps please plus point possible pretty probably proper pull push quite rather
read ready really related remain report request right same seem seen session several shall should show
side since some someone something sometimes somewhere soon start still stop such sure take than thank thanks that
their them themselves then there therefore these they thing think this those though through throughout thus
together toward towards try under unless until upon used user using usual very want well were what whatever
when whenever where wherever whether which while whole whom whose will with within without work working would
write yeah your yours yourself today tomorrow yesterday morning tonight week time again ensure everything
agent subagent session primary conversation extension harness repository repo branch commit main code file folder
directory path test check review fix update implement implementation build change add remove delete run
task step plan result output input message tool command prompt skill model context
error failure broken break problem bug feature support project system process data version status state
config configuration setting option default value field name type list view page line source function method
class object module package script service server client schema query production staging debug audit
investigate investigation analysis analyse analyze summary summarize finding document docs readme
create edit improve verify validate handle use set get find search call return send receive load save
new old good better best simple quick small large big real full last first final full other same
json html http https yaml todo
reply answer word exactly single true false level label section title call hand fresh deliver execute execution
lead background bash spawn worker manager reader reviewer operator preset trial confirm candidate retain owner
ownership repair defect quality correct correctness concrete evidence verify outcome objective goal purpose
decide decision determine establish produce approve approved explicit explicitly actual actually instead
three four five seven eight nine twice once half available limited long short
opus sonnet haiku fable astra flash kimi grok gemini deepseek claude codex anthropic openai
`;

/** Acronyms that name kinds of things in general, and short words that capitals do not make acronyms. */
const GENERIC_ACRONYMS = new Set(
	`api cli css csv ide llm pdf sdk url utc eta gpt add all and any are ask bug but can did end few fix for get
	got had has her him his how its let log may new nor not now off old one our out own put run say see set she
	too top try two use was way who why yes yet you`.split(/\s+/u),
);

/**
 * Plural folding only; stems that change meaning are left alone. `-es` is removed after the
 * sibilant endings that take it (box, crash, branch); `cache` and `niche` keep their final `e`.
 */
function fold(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && term.endsWith("sses")) return term.slice(0, -2);
	if (term.length > 4 && /(?:sh|x)es$/u.test(term)) return term.slice(0, -2);
	if (term.length > 4 && term.endsWith("ches"))
		return /[aeiou]ches$/u.test(term) && !/(?:ea|oa|ou)ches$/u.test(term) ? term.slice(0, -1) : term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !/(?:ss|us|is)$/u.test(term)) return term.slice(0, -1);
	return term;
}

/** Base forms that an -ing or -ed word may inflect, for the stop-word check only. */
function inflectionBases(term: string): string[] {
	const suffix = term.length >= 6 && term.endsWith("ing") ? 3 : term.length >= 5 && term.endsWith("ed") ? 2 : 0;
	if (suffix === 0) return [];
	const base = term.slice(0, -suffix);
	const bases = [base, `${base}e`];
	if (base.length >= 3 && base.at(-1) === base.at(-2)) bases.push(base.slice(0, -1));
	if (suffix === 2 && base.endsWith("i")) bases.push(`${base.slice(0, -1)}y`);
	return bases;
}

const STOP = new Set(
	STOP_WORDS.split(/\s+/u)
		.filter(Boolean)
		.map((word) => fold(word)),
);

function stopped(term: string): boolean {
	return STOP.has(term) || inflectionBases(term).some((base) => STOP.has(base));
}

/** Identifiers, hashes and numbers name items, not subjects; shared items are matched separately. */
function identifierLike(term: string): boolean {
	return /\d/u.test(term) && (/^[0-9a-f]+$/u.test(term) || /^\d/u.test(term));
}

/**
 * The folded term of one word as written, or undefined when the word names no subject. In text
 * that also has lowercase letters, a three-letter word in capitals is an acronym (SQL, MCP, RDS),
 * and a trailing s is its plural.
 */
function termOf(word: string, mixedCase: boolean): string | undefined {
	const acronym = mixedCase && /^\p{Lu}{3}s?$/u.test(word);
	const lower = word.toLowerCase();
	if (acronym) {
		const term = lower.slice(0, 3);
		return GENERIC_ACRONYMS.has(term) ? undefined : term;
	}
	if (lower.length < 4 || lower.length > 32 || identifierLike(lower)) return undefined;
	const term = fold(lower);
	return term.length < 4 || stopped(term) ? undefined : term;
}

/** Distinctive terms of the given texts, in first-seen order and bounded. */
export function topicTerms(texts: Iterable<string | undefined>): Set<string> {
	const terms = new Set<string>();
	let budget = MAX_TEXT;
	for (const text of texts) {
		if (!text || budget <= 0) continue;
		const slice = text.slice(0, budget);
		budget -= slice.length;
		const mixedCase = /\p{Ll}/u.test(slice);
		// Paths, URLs, addresses and snake_case identifiers name places and items, not subjects;
		// their components (home directories, hosts, tool prefixes) would relate unrelated sessions.
		// Camel case splits with an acronym prefix kept whole: HTTPServer, OAuthToken, parseJSON.
		const words = slice
			.replace(/\S*[/\\@~_]\S*/gu, " ")
			.replace(/(\p{Lu}{2,})(\p{Lu}\p{Ll}{2,})/gu, "$1 $2")
			.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
			.split(/[^\p{L}\p{N}]+/u);
		for (const word of words) {
			const term = termOf(word, mixedCase);
			if (term === undefined) continue;
			terms.add(term);
			if (terms.size >= MAX_TERMS) return terms;
		}
	}
	return terms;
}

/** Shared terms in alphabetical order, or none below the topic threshold. */
export function sharedTopics(self: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
	const [small, large] = self.size <= other.size ? [self, other] : [other, self];
	const shared: string[] = [];
	for (const term of small) if (large.has(term)) shared.push(term);
	if (shared.length < MIN_SHARED_TOPICS) return [];
	return shared.sort().slice(0, SHARED_TOPICS_SHOWN);
}
