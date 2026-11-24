import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodeEntities, format, parseArgs, parseSince, pubmedDay, query, UsageError } from "./query.mts";

const NOW = new Date("2026-11-25T00:00:00Z");
const SCRIPT = fileURLToPath(new URL("./query.mts", import.meta.url));

function fakeFetcher(bodies: Record<string, string>) {
	const requested: string[] = [];
	const fetcher = async (url: string) => {
		requested.push(url);
		const host = new URL(url).host + new URL(url).pathname;
		const body = bodies[host];
		if (body === undefined) throw new Error(`unexpected request ${url}`);
		return body;
	};
	return { fetcher, requested };
}

async function run(argv: string[], bodies: Record<string, string>) {
	const options = parseArgs(argv, NOW);
	const { fetcher, requested } = fakeFetcher(bodies);
	const output = format(options, await query(options, fetcher, NOW));
	return { output, requested: requested.map((url) => new URL(url)) };
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [SCRIPT, ...args], { timeout: 20_000 }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr });
		});
	});
}

test("relative and calendar windows resolve against the current time", () => {
	assert.equal(parseSince("30d", NOW).toISOString(), "2026-10-26T00:00:00.000Z");
	assert.equal(parseSince("2w", NOW).toISOString(), "2026-11-11T00:00:00.000Z");
	assert.equal(parseSince("2026-01-15", NOW).toISOString(), "2026-01-15T00:00:00.000Z");
	assert.throws(() => parseSince("last month", NOW), UsageError);
	assert.throws(() => parseSince("2026-13-45", NOW), UsageError);
});

test("arguments default to ten relevant stories and refuse options outside their source", () => {
	const options = parseArgs(["hn", "-q", "agent skills"], NOW);
	assert.deepEqual(
		{ ...options },
		{ source: "hn", query: "agent skills", limit: 10, sort: "relevance", kind: "story", site: "stackoverflow" },
	);
	assert.throws(() => parseArgs(["reddit", "-q", "x"], NOW), UsageError);
	assert.throws(() => parseArgs(["hn"], NOW), /--query is required/);
	assert.throws(() => parseArgs(["arxiv", "-q", "x", "--sort", "top"], NOW), /relevance, date/);
	assert.throws(() => parseArgs(["hn", "-q", "x", "--kind", "comment", "--sort", "top"], NOW), /stories, not comments/);
	assert.throws(() => parseArgs(["openalex", "-q", "x", "--limit", "51"], NOW), /1 to 50/);
	assert.throws(() => parseArgs(["arxiv", "-q", "x", "--kind", "comment"], NOW), /hn only/);
	assert.throws(() => parseArgs(["hn", "-q", "x", "--site", "serverfault"], NOW), /stackexchange only/);
	assert.throws(() => parseArgs(["hn", "-q", "x", "--since"], NOW), /needs a value/);
	assert.throws(() => parseArgs(["hn", "-q", "x", "--verbose", "1"], NOW), /unknown option/);
});

test("Hacker News stories carry points, comments, the story link and the discussion link", async () => {
	const body = JSON.stringify({
		nbHits: 2,
		hits: [
			{
				objectID: "501",
				created_at: "2026-11-20T10:00:00Z",
				title: "Skills &amp; agents",
				url: "https://example.com/post",
				points: 1,
				num_comments: 12,
			},
			{ objectID: "502", created_at: "2026-11-19T10:00:00Z", title: "Ask HN: skills?", points: 40, num_comments: 1 },
		],
	});
	const { output, requested } = await run(["hn", "-q", "agent skills", "--since", "30d", "--sort", "date"], {
		"hn.algolia.com/api/v1/search_by_date": body,
	});
	assert.equal(requested[0].searchParams.get("numericFilters"), `created_at_i>=${Date.parse("2026-10-26") / 1000}`);
	assert.equal(requested[0].searchParams.get("tags"), "story");
	assert.equal(
		output,
		[
			"hn | query: agent skills | stories | since 2026-10-26 | 2 matches | newest first | showing 2",
			"1. 2026-11-20 | 1 point, 12 comments | Skills & agents",
			"   https://example.com/post",
			"   https://news.ycombinator.com/item?id=501",
			"2. 2026-11-19 | 40 points, 1 comment | Ask HN: skills?",
			"   https://news.ycombinator.com/item?id=502",
		].join("\n"),
	);
});

test("Hacker News top stories are the most relevant matches re-ordered by points", async () => {
	const hits = [10, 300, 0, 45].map((points, index) => ({
		objectID: String(index),
		created_at: "2026-11-01T00:00:00Z",
		title: `story ${points}`,
		points,
		num_comments: 2,
	}));
	const { output, requested } = await run(["hn", "-q", "skills", "--sort", "top", "--limit", "2"], {
		"hn.algolia.com/api/v1/search": JSON.stringify({ nbHits: 4, hits }),
	});
	assert.equal(requested[0].searchParams.get("hitsPerPage"), "10");
	assert.match(output, /most points first \| showing 2\n1\. 2026-11-01 \| 300 points, 2 comments \| story 300\n/);
	assert.match(output, /2\. 2026-11-01 \| 45 points, 2 comments \| story 45\n/);
});

test("Hacker News comments show their text without markup and name the story", async () => {
	const body = JSON.stringify({
		nbHits: 1,
		hits: [
			{
				objectID: "77",
				created_at: "2026-11-01T00:00:00Z",
				author: "pat",
				comment_text: "<p>It works <i>well</i> &gt; 90% of the time",
				story_title: "Show HN: thing",
			},
		],
	});
	const { output } = await run(["hn", "-q", "thing", "--kind", "comment"], { "hn.algolia.com/api/v1/search": body });
	assert.match(output, /1\. 2026-11-01 \| comment by pat \| It works well > 90% of the time\n {3}on: Show HN: thing\n/);
});

test("arXiv queries add field prefixes and a submission window, and parse Atom entries", async () => {
	const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">14</opensearch:totalResults>
<entry><id>http://arxiv.org/abs/2611.00001v1</id><published>2026-11-23T03:51:00Z</published>
<title>Deep  Research
  Agents &amp; Evidence</title>
<author><name>A One</name></author><author><name>B Two</name></author><author><name>C Three</name></author><author><name>D Four</name></author>
<arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="x"/></entry></feed>`;
	const { output, requested } = await run(
		["arxiv", "-q", '"deep research" agent', "--since", "2026-11-01", "--sort", "date"],
		{
			"export.arxiv.org/api/query": xml,
		},
	);
	assert.equal(
		requested[0].searchParams.get("search_query"),
		'all:"deep research" AND all:agent AND submittedDate:[202611010000 TO 202611250000]',
	);
	assert.equal(requested[0].searchParams.get("sortBy"), "submittedDate");
	assert.equal(
		output,
		[
			'arxiv | query: "deep research" agent | since 2026-11-01 | 14 matches | newest first | showing 1',
			"1. 2026-11-23 | cs.CL | Deep Research Agents & Evidence",
			"   A One, B Two, C Three et al.",
			"   https://arxiv.org/abs/2611.00001v1",
		].join("\n"),
	);
	const prefixed = parseArgs(["arxiv", "-q", "ti:retrieval AND cat:cs.IR"], NOW);
	const { fetcher, requested: raw } = fakeFetcher({ "export.arxiv.org/api/query": "<feed></feed>" });
	await query(prefixed, fetcher, NOW);
	assert.equal(new URL(raw[0]).searchParams.get("search_query"), "ti:retrieval AND cat:cs.IR");
});

test("OpenAlex works show citations, venue and DOI, sorted by citations on request", async () => {
	const body = JSON.stringify({
		meta: { count: 3 },
		results: [
			{
				id: "https://openalex.org/W1",
				doi: "https://doi.org/10.1/x",
				display_name: "A survey",
				publication_date: "2026-05-09",
				cited_by_count: 1,
				type: "article",
				primary_location: { source: { display_name: "Journal X" } },
			},
			{ id: "https://openalex.org/W2", display_name: "Preprint", publication_date: "2026-02-01", cited_by_count: 0 },
		],
	});
	const { output, requested } = await run(
		["openalex", "-q", "rag evaluation", "--since", "2026-01-01", "--sort", "top"],
		{
			"api.openalex.org/works": body,
		},
	);
	assert.equal(requested[0].searchParams.get("sort"), "cited_by_count:desc");
	assert.equal(requested[0].searchParams.get("filter"), "from_publication_date:2026-01-01");
	assert.match(output, /\| 3 matches \| most cited first \| showing 2\n/);
	assert.match(
		output,
		/1\. 2026-05-09 \| 1 citation \| A survey\n {3}Journal X, article\n {3}https:\/\/doi\.org\/10\.1\/x/,
	);
	assert.match(output, /2\. 2026-02-01 \| 0 citations \| Preprint\n {3}https:\/\/openalex\.org\/W2$/);
});

test("Stack Exchange questions show votes, answers, acceptance and tags, and report API errors", async () => {
	const body = JSON.stringify({
		quota_remaining: 297,
		items: [
			{
				creation_date: 1674691200,
				title: "How to prevent TaskGroup from cancelling &quot;all&quot; tasks",
				score: 17,
				answer_count: 4,
				accepted_answer_id: 9,
				tags: ["python", "python-asyncio"],
				link: "https://stackoverflow.com/q/1",
			},
		],
	});
	const { output, requested } = await run(
		["stackexchange", "-q", "taskgroup", "--site", "serverfault", "--sort", "top"],
		{
			"api.stackexchange.com/2.3/search/advanced": body,
		},
	);
	assert.equal(requested[0].searchParams.get("site"), "serverfault");
	assert.equal(requested[0].searchParams.get("sort"), "votes");
	assert.equal(
		output,
		[
			"stackexchange | query: taskgroup | site: serverfault | most votes first | showing 1",
			"297 requests left in today's anonymous quota",
			'1. 2023-01-26 | 17 votes, 4 answers, accepted answer | How to prevent TaskGroup from cancelling "all" tasks',
			"   python, python-asyncio",
			"   https://stackoverflow.com/q/1",
		].join("\n"),
	);
	const failing = fakeFetcher({
		"api.stackexchange.com/2.3/search/advanced": JSON.stringify({ error_id: 502, error_message: "throttle violation" }),
	});
	await assert.rejects(
		query(parseArgs(["stackexchange", "-q", "x"], NOW), failing.fetcher, NOW),
		/Stack Exchange error 502: throttle violation/,
	);
});

test("Stack Exchange answers to one question show their text, votes and acceptance without a query", async () => {
	const body = JSON.stringify({
		quota_remaining: 290,
		items: [
			{
				answer_id: 75261668,
				creation_date: 1674841841,
				score: 11,
				is_accepted: true,
				body: "<p><strong>Update</strong>\nUse <code>asyncio.shield</code> &amp; keep a reference.</p>",
			},
		],
	});
	const { output, requested } = await run(["stackexchange", "--question", "75250788", "--site", "unix"], {
		"api.stackexchange.com/2.3/questions/75250788/answers": body,
	});
	assert.equal(requested[0].searchParams.get("filter"), "withbody");
	assert.equal(requested[0].searchParams.get("sort"), "votes");
	assert.equal(
		output,
		[
			"stackexchange | answers to question 75250788 | site: unix | most votes first | showing 1",
			"290 requests left in today's anonymous quota",
			"1. 2023-01-27 | 11 votes, accepted | Update Use asyncio.shield & keep a reference.",
			"   https://unix.stackexchange.com/a/75261668",
		].join("\n"),
	);
	assert.throws(() => parseArgs(["hn", "--question", "1"], NOW), /stackexchange only/);
	assert.throws(() => parseArgs(["stackexchange", "--question", "abc"], NOW), /numeric question id/);
});

test("PubMed results date each record by its PubMed listing and link a plain-text abstract", async () => {
	const search = JSON.stringify({ esearchresult: { count: "124", idlist: ["42849557", "1"] } });
	const summary = JSON.stringify({
		result: {
			uids: ["42849557", "1"],
			42849557: {
				title: "Intermittent fasting in Alzheimer&#39;s disease.",
				source: "Physiol Behav",
				sortpubdate: "2027/01/01 00:00",
				epubdate: "2026 Oct 8",
				history: [
					{ pubstatus: "received", date: "2025/02/21 00:00" },
					{ pubstatus: "pubmed", date: "2026/10/08 23:31" },
				],
				authors: [{ name: "Shrirame D" }, { name: "Other X" }],
			},
			1: { title: "Old record", source: "J Old", sortpubdate: "1975/06/01 00:00", authors: [] },
		},
	});
	const { output, requested } = await run(
		["pubmed", "-q", "intermittent fasting", "--since", "60d", "--sort", "date"],
		{
			"eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi": search,
			"eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi": summary,
		},
	);
	assert.equal(requested[0].searchParams.get("mindate"), "2026/09/26");
	assert.equal(requested[0].searchParams.get("maxdate"), "2026/11/25");
	assert.equal(requested[0].searchParams.get("sort"), "pub_date");
	assert.equal(requested[1].searchParams.get("id"), "42849557,1");
	assert.match(
		output,
		/1\. 2026-10-08 \| Physiol Behav \| Intermittent fasting in Alzheimer's disease\.\n {3}Shrirame D et al\.\n/,
	);
	assert.match(output, /efetch\.fcgi\?db=pubmed&id=42849557&rettype=abstract&retmode=text/);
	assert.match(output, /2\. 1975-06-01 \| J Old \| Old record\n {3}https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/1\//);
});

test("an empty result says that the query completed and found nothing", async () => {
	const { output, requested } = await run(["pubmed", "-q", "nothing here"], {
		"eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi": JSON.stringify({ esearchresult: { count: "0", idlist: [] } }),
	});
	assert.equal(requested.length, 1);
	assert.equal(output, "pubmed | query: nothing here | 0 matches | most relevant first | showing 0\nNo matches.");
});

test("PubMed dates and HTML entities convert to plain forms", () => {
	assert.equal(pubmedDay("2026/10/08 23:31"), "2026-10-08");
	assert.equal(pubmedDay("2026 Oct 8"), "2026-10-08");
	assert.equal(pubmedDay("2026 Dec"), "2026-12-01");
	assert.equal(pubmedDay("2026"), "2026-01-01");
	assert.equal(pubmedDay(""), "");
	assert.equal(decodeEntities("&lt;a&gt; &amp; &#39;b&#39; &#x2014; &unknown;"), "<a> & 'b' \u2014 &unknown;");
});

test("the command prints help, and refuses bad arguments with exit 2 before any request", async () => {
	const help = await runCli(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /^Query public research APIs/);
	const bad = await runCli(["reddit", "-q", "x"]);
	assert.equal(bad.code, 2);
	assert.match(bad.stderr, /first argument must be one of: hn, arxiv, openalex, stackexchange, pubmed/);
	assert.equal(bad.stdout, "");
});
