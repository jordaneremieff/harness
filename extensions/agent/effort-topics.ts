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

/** English function words, and words that describe agent work in general rather than its subject. */
const STOP = new Set(
	`
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
side since some someone something sometimes somewhere soon start still stop such sure take than thank that
their them themselves then there therefore these they thing think this those though through throughout thus
together toward towards try under unless until upon used user using usual very want well were what whatever
when whenever where wherever whether which while whole whom whose will with within without work working would
write yeah your yours yourself
agent session primary conversation extension harness repository repo branch commit main code file folder
directory path test tests check review fix update implement implementation build change add remove delete run
task step plan result output input message tool command prompt skill model context
`
		.split(/\s+/u)
		.filter(Boolean)
		.map(fold),
);

/** Plural folding only; stems that change meaning are left alone. */
function fold(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && term.endsWith("sses")) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !/(?:ss|us|is)$/u.test(term)) return term.slice(0, -1);
	return term;
}

/** Identifiers, hashes and numbers name items, not subjects; shared items are matched separately. */
function identifierLike(term: string): boolean {
	return /\d/u.test(term) && (/^[0-9a-f]+$/u.test(term) || /^\d/u.test(term));
}

/** The folded term of one lowercase word, or undefined when the word names no subject. */
function termOf(word: string): string | undefined {
	if (word.length < 4 || word.length > 32 || identifierLike(word)) return undefined;
	const term = fold(word);
	return term.length < 4 || STOP.has(term) ? undefined : term;
}

/** Distinctive terms of the given texts, in first-seen order and bounded. */
export function topicTerms(texts: Iterable<string | undefined>): Set<string> {
	const terms = new Set<string>();
	let budget = MAX_TEXT;
	for (const text of texts) {
		if (!text || budget <= 0) continue;
		const slice = text.slice(0, budget);
		budget -= slice.length;
		const words = slice
			.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u);
		for (const word of words) {
			const term = termOf(word);
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
