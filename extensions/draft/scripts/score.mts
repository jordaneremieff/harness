// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import type { Doc, Hit } from "./detect.mts";
import { COMPONENTS, type ScoredComponent, type Scoring } from "./rules.mts";

export type Band = "green" | "amber" | "red";

export interface PlacedHit {
	hit: Hit;
	wordIndex: number;
}

export interface ScoreInput {
	words: number;
	sentenceLengths: number[];
	anchors: number;
	hits: PlacedHit[];
}

export interface ComponentReport {
	value: number;
	metrics: Record<string, number | null>;
}

export interface ScoreReport {
	sq: number;
	band: Band | null;
	reliable: boolean;
	components: Record<ScoredComponent, ComponentReport>;
}

const ANCHOR_PATTERNS: RegExp[] = [
	/\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]+\b/g,
	/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
	/(?:\/[a-zA-Z0-9_.-]+){2,}|(?<![a-zA-Z0-9_.-])(?:[a-zA-Z0-9_.-]+\/){2,}[a-zA-Z0-9_.-]+\.[a-z0-9]+/g,
	/\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/g,
	/\b\d+(?:\.\d+)?\s*(?:ms|us|ns|s|m|h|B|KB|MB|GB|TB|req\/s|rps|qps|Hz|kHz|MHz|GHz|kbps|mbps)\b|\b\d+(?:\.\d+)?%/g,
	/\b[1-5]\d{2}\s+(?:OK|Created|Accepted|No Content|Moved|Found|Bad Request|Unauthorized|Forbidden|Not Found|Internal Server Error|Bad Gateway|Service Unavailable)\b/g,
];
const CVE = /\bCVE-\d{4}-\d{4,7}\b/gi;

/** Count verifiable anchors in the prose that the meter extracted: code spans, identifiers, paths, versions, measures. */
export function countAnchors(doc: Doc): number {
	let total = doc.ex.fenceCount * 3 + doc.ex.inlineCodeCount;
	for (const unit of doc.ex.units) {
		for (const pattern of ANCHOR_PATTERNS) total += unit.literal.match(pattern)?.length ?? 0;
		total += 2 * (unit.literal.match(CVE)?.length ?? 0);
	}
	return total;
}

export function placeHits(doc: Doc, hits: Hit[], wordOffset: number): PlacedHit[] {
	return hits.map((hit) => {
		let low = 0;
		let high = doc.wordStarts.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((doc.wordStarts[mid] ?? 0) < hit.start) low = mid + 1;
			else high = mid;
		}
		return { hit, wordIndex: wordOffset + low };
	});
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const round = (value: number, places: number): number => {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
};

function lexicalComponent(input: ScoreInput, scoring: Scoring, words: number): ComponentReport {
	const hits = input.hits.filter((entry) => entry.hit.rule.component === "lexical");
	const indices = hits.map((entry) => entry.wordIndex).sort((a, b) => a - b);
	const { windowWords, isolatedShare, stepShare, maxNeighbours } = scoring.cluster;
	let weighted = 0;
	let clustered = 0;
	for (const entry of hits) {
		let neighbours = 0;
		for (const index of indices) {
			if (index < entry.wordIndex - windowWords) continue;
			if (index > entry.wordIndex + windowWords) break;
			neighbours += 1;
		}
		neighbours -= 1;
		if (neighbours > 0) clustered += 1;
		weighted += (entry.hit.rule.weight ?? 0) * (isolatedShare + stepShare * Math.min(neighbours, maxNeighbours));
	}
	const density = (100 * weighted) / words;
	return {
		value: clamp01(density / scoring.lexicalDivisor),
		metrics: {
			hits: hits.length,
			clusteredHits: clustered,
			weighted: round(weighted, 2),
			densityPer100: round(density, 2),
		},
	};
}

function sumWeights(input: ScoreInput, component: ScoredComponent): { count: number; weight: number } {
	let count = 0;
	let weight = 0;
	for (const entry of input.hits) {
		if (entry.hit.rule.component !== component) continue;
		count += 1;
		weight += entry.hit.rule.weight ?? 0;
	}
	return { count, weight };
}

function geometryComponent(input: ScoreInput, scoring: Scoring, words: number): ComponentReport {
	const { count, weight } = sumWeights(input, "geometry");
	const density = (100 * weight) / words;
	const lengths = input.sentenceLengths;
	const { kneeCv, spanCv, minSentences } = scoring.burstiness;
	let cv: number | null = null;
	let penalty = 0;
	if (lengths.length >= minSentences) {
		const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
		const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
		cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
		penalty = clamp01((kneeCv - cv) / spanCv);
	}
	const share = scoring.geometryDensityShare;
	const densityTerm = clamp01(density / scoring.geometryDensityDivisor);
	return {
		value: clamp01(share * densityTerm + (1 - share) * penalty),
		metrics: {
			hits: count,
			densityPer100: round(density, 2),
			sentenceLengthCv: cv === null ? null : round(cv, 3),
			burstinessPenalty: round(penalty, 3),
		},
	};
}

function epistemicComponent(input: ScoreInput, scoring: Scoring, words: number): ComponentReport {
	const { count, weight } = sumWeights(input, "epistemic");
	const ratio = weight / Math.max(input.anchors, 1);
	const density = (100 * weight) / words;
	const value = clamp01(
		0.5 * (ratio / scoring.epistemic.ratioDivisor) + 0.5 * (density / scoring.epistemic.densityDivisor),
	);
	return {
		value,
		metrics: {
			hits: count,
			anchors: input.anchors,
			fluffToAnchorRatio: round(ratio, 3),
			densityPer100: round(density, 2),
		},
	};
}

function launderingComponent(input: ScoreInput, scoring: Scoring, words: number): ComponentReport {
	const { count, weight } = sumWeights(input, "laundering");
	const density = (100 * weight) / words;
	return {
		value: clamp01(density / scoring.launderingDivisor),
		metrics: { hits: count, densityPer100: round(density, 2) },
	};
}

export function computeScore(input: ScoreInput, scoring: Scoring): ScoreReport {
	const words = Math.max(input.words, 1);
	const components = {
		lexical: lexicalComponent(input, scoring, words),
		geometry: geometryComponent(input, scoring, words),
		epistemic: epistemicComponent(input, scoring, words),
		laundering: launderingComponent(input, scoring, words),
	};
	let total = 0;
	for (const name of COMPONENTS) total += scoring.componentWeights[name] * components[name].value;
	const sq = Math.max(0, Math.min(100, round(100 * total, 2)));
	const reliable = input.words >= scoring.minWords;
	let band: Band | null = null;
	if (reliable) band = sq < scoring.bands.green ? "green" : sq < scoring.bands.amber ? "amber" : "red";
	for (const name of COMPONENTS) components[name].value = round(components[name].value, 4);
	return { sq, band, reliable, components };
}
