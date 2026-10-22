# Lexicon

This file is generated from `data/rules.json` by `scripts/render-references.mts`. Do not edit it by hand: change the data and run the script.

The vocabulary and phrase rules, with their exemptions. A listed word is not banned. The meter judges density: one hit counts little and a cluster dominates. An exemption marks an ordinary technical sense, for example a test harness or dynamic dispatch. Terms ending in `*` match any word ending. Patterns are regular expressions.

## Contents

- [Lexical](#lexical)
- [Geometry](#geometry)
- [Epistemic](#epistemic)
- [Laundering](#laundering)
- [Punctuation](#punctuation)
- [Structure](#structure)
- [Spelling](#spelling)
- [Times](#times)
- [Commit and review text](#commit-and-review-text)

## Lexical

### lexical.tier-one

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 2.5.

- Terms: `delv*`, `tapestr*`, `testament*`, `paramount`, `multifaceted`, `burgeon*`, `vibrant*`, `interplay*`, `holistic*`, `bespoke`, `seamless*`, `unparalleled`, `indelible`
- Exempt when the hit overlaps: `\bdelve\s+(?:debugger|attach|exec|dap)\b|\bdlv\b`

### lexical.beacon

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 2.5.

- Terms: `beacon*`
- Exempt when the hit overlaps: `\b(?:bluetooth|ble|ibeacon|radio|wi-?fi|analytics|tracking|web|send)\s+beacons?\b|\bbeacon\s+(?:frame|interval|api|packet|signal)\b`

### lexical.pivotal

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 2.5.

- Terms: `pivotal*`
- Exempt when the hit overlaps: `\bpivotal\s+tracker\b`

### lexical.underscore-verb

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 2.5.

- Terms: `underscor*`
- Exempt when the hit overlaps: `\b(?:an?|the|leading|trailing|single|double|one|each)\s+underscor\w*\b|\bunderscore\s+(?:character|prefix|separator|key)\b`

### lexical.tier-two

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.5.

- Terms: `crucial*`, `embark*`, `nuance*`, `poised`, `cornerstone*`, `transformative`, `shed light`, `shedding light`, `showcas*`, `garner*`, `bolster*`, `intricate`, `intricacies`, `focal point`, `unleash*`, `empower*`, `spearhead*`, `unlock the potential`

### lexical.resonate

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.5.

- Terms: `resonat*`
- Exempt when this appears nearby: `\b(?:frequency|circuit|cavity|hz|oscillat\w+)\b`

### lexical.foster

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.5.

- Terms: `foster*`
- Exempt when the hit overlaps: `\bfoster\s+(?:care|child|children|parent|home|family)\b`

### lexical.navigate

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.5.

- Pattern: `\bnavigat(?:e|es|ed|ing)\b`
- Exempt when the hit overlaps: `\bnavigat\w*\s+(?:to|back|up|down|forward)\b|\bnavigat\w*\s+(?:the\s+)?(?:menu|tree|page|directory|file|folder|dom|hierarchy|graph|filesystem|history|tabs?)\b`

### lexical.harness-verb

Verb use of 'harness' as a power metaphor. Severity: scored, lexical, weight 1.5.

- Pattern: `\bharness(?:ed|ing)\b|(?<!\b(?:the|this|our|a|an|test|pi|that|its|their|my|your|fuzz|wiring|safety)\s)\bharness(?:es)?\s+(?:the|its|their|our|your|this|that|these|those|a|an|all|every|full|more|new|existing|available|power|potential)\b`

### lexical.elevate

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.5.

- Terms: `elevat*`
- Exempt when the hit overlaps: `\belevated\s+(?:privilege|permission|access|rights|prompt|shell|command|risk|temperature)|privilege\s+elevation|\belevate\s+(?:to\s+)?(?:root|admin|sudo|privilege)`

### lexical.landscape

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.5.

- Terms: `landscape*`
- Exempt when the hit overlaps: `\blandscape\s+(?:orientation|mode|layout|photo|image|painting)\b|\b(?:portrait|page)\s+(?:and|or)\s+landscape\b`

### lexical.realm

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.5.

- Terms: `realm*`
- Exempt when the hit overlaps: `\b(?:kerberos|auth\w*|security|keycloak|oidc|sso|domain)\s+realm\b|\brealm\s+(?:name|id|admin|db|database|sdk)\b`

### lexical.tier-three

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.

- Terms: `notably`, `comprehensive*`, `overarching`, `meticulous*`, `synerg*`, `leverag*`, `streamlin*`, `facilitat*`, `utilis*`, `utiliz*`, `enhanc*`
- Exempt when the hit overlaps: `\bleverage\s+ratio\b|\b(?:financial|operating)\s+leverage\b`

### lexical.imperative-paradigm

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.

- Pattern: `\b(?:it\s+is|it['\u2019]s|become|becomes)\s+imperative\b|\bimperative\s+(?:to|that)\b|\bparadigms?\b`
- Exempt when the hit overlaps: `\b(?:programming|computing|object-oriented|functional|actor)\s+paradigms?\b`

### lexical.robust

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.

- Terms: `robust*`
- Exempt when the hit overlaps: `\brobust\s+(?:standard\s+errors?|regression|statistic\w*|estimator|to\s+outliers)\b|\bhuber\b`

### lexical.dynamic

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.

- Terms: `dynamic*`
- Exempt when the hit overlaps: `\bdynamic(?:ally)?\s+(?:dispatch|programming|typed|typing|linked|linking|import|array|range|language|memory|allocat\w*|sql|dns|port|content|table|routing|require|binding|scope|proxy|ip|host|library|loading|analysis|generated)\b`

### lexical.align

Stock vocabulary that adds tone but no fact. Severity: scored, lexical, weight 1.

- Terms: `align*`
- Exempt when the hit overlaps: `\b(?:memory|byte|cache|data|struct|word|page)\s+align\w*|\balign\w*\s+(?:allocation|access|padding|requirement|to\s+\d+)|\balign\s+(?:the\s+)?(?:columns|text|center|left|right|items)\b|\bvertical\s+align\w*`

### lexical.emphasis-swap

Portable emphasis word that stands in for a reason. Severity: scored, lexical, weight 1.

- Terms: `critical*`, `vital`, `central`, `foundational`, `bedrock`
- Exempt when the hit overlaps: `\bcritical(?:ly)?\s+(?:path|section|bug|fix|severity|error|failure|vulnerabilit\w+|alert|issue|priority|mass|point|system|infrastructure|update|patch|incident|dependency|temperature)\b`, `\bcentral\s+(?:processing|unit|server|bank|park|limit|difference|tendency|nervous)\b`, `\bvital\s+signs?\b`

### lexical.agent-speak

Stock agent vocabulary. Severity: scored, lexical, weight 1.

- Terms: `load-bearing`, `seam`, `seams`, `spine`, `substrate`, `wedged`, `belt-and-suspenders`, `blast radius`, `gated on`, `plumb through`, `plumbed through`, `freeze the binding`, `durable path forward`, `that's not nothing`, `that’s not nothing`
- Exempt when this appears nearby: `\bseam\s+(?:carving|allowance)\b|\bsewing\b|\bseamless\b`, `\b(?:spin(?:al|e)\b.*\b(?:injury|surgeon|surgery|vertebra\w*)|surgeon|surgery|vertebra\w*|injury)\b`, `\b(?:wafer|silicon|enzyme|semiconductor)\b`

### lexical.agent-speak-mild

Overused agent vocabulary. Severity: scored, lexical, weight 0.5.

- Terms: `cadence`, `provenance`, `canonical`, `anchored`, `hard stop`, `hard gate`, `hard boundary`, `fail closed`, `surfaced`
- Exempt when the hit overlaps: `\b(?:build|slsa|supply[- ]chain|artifact|data)\s+provenance\b|\bcanonical\s+(?:url|name|form|link|path|tag|id|representation)\b`

### lexical.developer-term

Use 'operator' for the person who runs the harness. Severity: advisory.

- Terms: `developer`, `developers`

### lexical.coined-compound

Coined hyphenated compound. Severity: scored, lexical, weight 1.5.

- Pattern: `\b[a-z]{2,}-(?:side|level|gated|backed|first|safe|matched|layer|surface|path|boundary|facing|shaped|bound|scoped)\b`
- Exempt when the hit overlaps: `\b(?:client|server|user|kernel|file|line|block|row|top|low|high|mid|app|board|ring|region|account|org|package|module|function|statement|data|thread|memory|type|null|exception|panic|source|mobile|offline|local|api|cloud|test|spec|hash|read|write|control|critical|code|text|word|page|cache|disk|network|host|side|account)-(?:side|level|first|safe|facing|bound|scoped|layer|path|shaped|surface)\b|\bread-after-write\b|\bfirst-class\b`

### lexical.coined-curated

Known coined phrase. Severity: scored, lexical, weight 2.

- Terms: `varying-dates`, `customer-side`, `never-fetched`, `quality-gated`, `flappy`, `principled fix`, `claim gate`, `first wedge`, `capacity floor`, `platform runway`, `pragmatic intake`, `intake-driven`, `milestone-driven`, `premature generic`, `competing modes of work`, `v1 frame`, `load-bearing moment`, `the shape of the problem`

### lexical.business-buzz

Business buzz phrase. Severity: scored, lexical, weight 2.

- Terms: `move the needle`, `low-hanging fruit`, `circle back`, `double-click on`, `north star`, `touch base`, `paradigm shift`, `throw-over-the-wall`, `0-to-1`, `scalability plays`, `late to the party`, `two decisions for you`, `it is worth noting that`, `bandwidth`
- Exempt when this appears nearby: `\b(?:network|memory|disk|bus|link|spectrum|mbps|gbps|kbps|throughput|latency)\b`

## Geometry

### geometry.negative-parallelism

Negative parallelism: a view nobody held, knocked down. Severity: scored, geometry, weight 2.5.

- Pattern: `\bnot\s+(?:only|merely|just|simply)\b[^.!?\n]{1,120}?\b(?:but(?:\s+also)?|and\s+also)\b|\b(?:it|this|that)(?:['\u2019]s|\s+is|\s+isn['\u2019]t|\s+is\s+not)\s+not\s+(?:just\s+|only\s+|merely\s+)?(?:an?\s+|the\s+|about\s+)?[^.,;!?\n]{1,60}[,;]\s*(?:it['\u2019]s|it\s+is|but)\b|\b(?:it|this|that)\s+isn['\u2019]t\s+(?:just|only|merely|about)\s+[^.,;!?\n]{1,60}[,;]\s*(?:it['\u2019]s|it\s+is|but)\b|\bno\s+\w+,\s+no\s+\w+,\s+(?:just|only)\b|\bnot\s+[^.,;!?\n]{1,40},\s+but\s+rather\b`
- Exempt when this appears nearby: `\b(?:you|they|he|she|we|someone|the\s+docs?|the\s+spec)\s+(?:said|wrote|asked|claimed|thought|assumed|expected|stated|says|writes)\b`

### geometry.copula-avoidance

Verb that avoids 'is'. Severity: scored, geometry, weight 2.

- Pattern: `\b(?:serves?|stands?|standing|serving)\s+as\b|\bacts?\s+as\b|\b(?:functions?|operates?)\s+as\b|\bembod(?:y|ies|ied|ying)\b|\bmark(?:s|ing)\s+an?\s+(?:important|new|significant|pivotal|key|major|turning|shift|milestone|watershed|departure)\b|\b(?:highlighting|underscoring)\s+the\b`
- Exempt when the hit overlaps: `\b(?:serves?|acts?|functions?|operates?)\s+as\s+(?:an?\s+|the\s+)?(?:proxy|gateway|bridge|adapter|buffer|cache|filter|router|relay|client|server|leader|primary|replica|fallback|stand-in|placeholder|wrapper|mediator|facade|load\s+balancer|entry\s*point|default|key|source\s+of\s+truth|lock|mutex|barrier|sentinel|index|namespace|identifier|input|output|argument|parameter|callback|handler|listener|observer)\b`, `\bfunctions?\s+as\s+(?:expected|intended|designed|documented)\b`

### geometry.individually-collectively

Individually/collectively two-step. Severity: scored, geometry, weight 2.

- Pattern: `\bindividually\b[^.!?\n]{0,120}\bcollectively\b|\bcollectively\b[^.!?\n]{0,120}\bindividually\b`

## Epistemic

### epistemic.candour-frame

Candour frame that splits the message into spin and truth. Severity: hard.

- Pattern: `\b(?:to\s+be\s+(?:honest|frank|fair|candid|transparent|upfront)|(?:honestly|frankly|candidly)|(?:the|one|my)\s+honest\s+(?:part|truth|answer|caveat|shape|version|assessment|take)|honest\s+caveat|in\s+all\s+honesty|if\s+i['\u2019]?m\s+being\s+honest|i\s+(?:will|'ll)\s+be\s+(?:honest|direct|blunt|frank))\b`
- Exempt when the hit overlaps: `["\u201C][^"\u201D\n]{0,30}\b(?:honest|frank|candid|fair)\w*[^"\u201D\n]{0,30}["\u201D]`

### epistemic.scaffold-frame

Frame that announces a point instead of making it. Severity: scored, epistemic, weight 2.

- Pattern: `\bit(?:\s+is|['\u2019]s)\s+(?:crucial|vital|important|worth\s+noting|worth\s+highlighting|worth\s+mentioning|essential)(?:\s+to\b|\s+that\b)|\bin\s+conclusion\b|\bit\s+should\s+be\s+noted\s+that\b|\bat\s+its\s+core\b|\bin\s+essence\b|\bwithout\s+further\s+ado\b|\bin\s+order\s+to\s+ensure\b|\bas\s+(?:mentioned|noted|discussed)\s+(?:previously|earlier|above)\b|\bin\s+today['\u2019]s\s+(?:fast-paced\s+|dynamic\s+|modern\s+|digital\s+)?landscape\b|\bneedless\s+to\s+say\b|\blooking\s+ahead\b|\bas\s+we\s+move\s+forward\b|\bwhen\s+it\s+comes\s+to\b`

### epistemic.connector-filler

Sentence-opening connector with no relation to build. Severity: scored, epistemic, weight 1.

- Pattern: `(?<=^|[.!?:]\s+)(?:furthermore|moreover|additionally|importantly|notably),`

### epistemic.signpost

Signpost that announces structure. Severity: scored, epistemic, weight 2.

- Pattern: `\bhere\s+is\s+the\s+problem\s+as\s+i\s+understand\s+it\b|\bone\s+thing\s+stays\s+open\b|\bhere['\u2019]s\s+what\s+(?:happened|changed|matters)\b|\bthe\s+short\s+version\b|\bthe\s+key\s+takeaway\b|\bbottom\s+line\b|\bin\s+summary\b|\bto\s+summari[sz]e\b|\btl;?dr\b|\bwhat\s+this\s+means\b|\bhere\s+is\s+the\s+breakdown\b|\blet['\u2019]s\s+break\s+(?:this|it)\s+down\b|\bthere\s+are\s+(?:two|three|four|several)\s+things\b|\bi\s+will\s+walk\s+you\s+through\b`

### epistemic.root-cause-reveal

Staged reveal of a cause. Severity: scored, epistemic, weight 2.

- Pattern: `\bunderneath\s+all\s+of\s+(?:it|this)\b|\bthe\s+real\s+(?:issue|problem|story)\s+is\b|\bthe\s+actual\s+cause\b|\bat\s+the\s+heart\s+of\b|\bhere['\u2019]s\s+the\s+kicker\b|\bhere['\u2019]s\s+where\s+it\s+gets\s+interesting\b|\bsmoking\s+gun\b|\bit\s+turns\s+out\s+that\b`
- Exempt when the hit overlaps: `\bturns\s+out\s+that\s+(?:the\s+)?(?:file|flag|test|config|version)\b`

### epistemic.stock-opener

Chat pleasantry or apology opener. Severity: scored, epistemic, weight 2.5.

- Pattern: `(?<=^|[.!?]\s+)(?:certainly|absolutely|sure\s+thing|of\s+course|great\s+(?:question|point|catch)|good\s+(?:question|catch|point)|excellent\s+(?:question|point))\b[!,.]|\byou['\u2019]?re\s+absolutely\s+right\b|\byou\s+are\s+absolutely\s+right\b|\byou['\u2019]?re\s+right\s+to\s+push\s+back\b|\bi['\u2019]d\s+be\s+happy\s+to\b|\bi\s+would\s+be\s+happy\s+to\b|\bi\s+apologi[sz]e\b|\bapologies\s+for\b|\bmy\s+apologies\b|\bsorry\s+for\s+the\s+confusion\b|\blet['\u2019]s\s+dive\s+in\b`

### epistemic.closing-offer

Closing offer that adds no fact. Severity: scored, epistemic, weight 2.

- Pattern: `\bsay\s+the\s+word\b|\blet\s+me\s+know\s+if\b|\bfeel\s+free\s+to\s+(?:ask|reach|let)\b|\bhappy\s+to\s+help\b|\bhope\s+this\s+helps\b|\bdon['\u2019]t\s+hesitate\s+to\b|\bwant\s+me\s+to\s+proceed\b`

### epistemic.closing-menu

Closing menu built on context the reader may not have. Severity: scored, epistemic, weight 1.5.

- Pattern: `\bwould\s+you\s+like\s+me\s+to\b[^?\n]{0,200}\bor\b[^?\n]{0,200}\?`

### epistemic.vague-authority

Authority claimed without a source. Severity: scored, epistemic, weight 2.

- Pattern: `\bit\s+is\s+(?:widely|generally|commonly)\s+(?:understood|accepted|known|believed)\b|\bit\s+is\s+well\s+known\b|\b(?:many|most|some)\s+experts\s+(?:say|agree|believe|note)\b|\b(?:studies|research)\s+(?:show|shows|suggest|suggests)\b|\bindustry\s+observers\b|\bprominent\s+(?:blogs|voices)\b|\bexperts\s+agree\b`
- Exempt when this appears nearby: `\d+\s*%|\[\d+\]|\(\p{L}+,?\s+\d{4}\)`

### epistemic.performed-precision

Precision asserted without naming the check. Severity: scored, epistemic, weight 3.

- Pattern: `\bbyte[- ]for[- ]byte\b|\bbyte-identical\b|\bbit[- ]for[- ]bit\b|\bexactly\s+identical\b|\bpixel[- ]perfect\b`
- Exempt when this appears nearby: `\b(?:cmp|diff|sha\d*|shasum|md5|checksum|hash|digest)\b`

### epistemic.hollow-emphasis

Emphasis word with nothing behind it. Severity: scored, epistemic, weight 1.

- Pattern: `\bthe\s+\w+\s+itself\s+(?:is|was|becomes|has)\b|\bsimply\s+(?:put|stated|said)\b|\b(?:really|truly|genuinely|fundamentally)\s+(?:matters?|important|crucial|critical|essential)\b|\bat\s+the\s+end\s+of\s+the\s+day\b`

### epistemic.hedge-stack

Stacked or unearned hedge. Severity: scored, epistemic, weight 1.5.

- Pattern: `\b(?:might|may|could)\s+(?:potentially|possibly|perhaps)\b|\bi\s+could\s+be\s+wrong\b|\bjust\s+a\s+humble\s+thought\b|\bit\s+could\s+be\s+argued\b|\bit\s+might\s+perhaps\b|\barguably\b`

### epistemic.false-balance

Balance staged where the evidence is settled. Severity: scored, epistemic, weight 1.5.

- Pattern: `\bthe\s+truth\s+(?:likely\s+|probably\s+)?lies\s+somewhere\s+in\s+between\b|\bon\s+the\s+one\s+hand\b`

### epistemic.agent-narration

Tool or edit narration in the reply. Severity: scored, epistemic, weight 2.

- Pattern: `^(?:now\s+i(?:['\u2019]ll|\s+will)\b|i\s+will\s+now\b|let\s+me\s+(?:now\s+)?(?:check|examine|look|read|run|take\s+a\s+look)\b|running\s+\w+\.\.\.|looking\s+at\s+lines?\s+\d+|i\s+(?:have\s+)?updated\s+line\s+\d+)`

### epistemic.unexplained-code

Coded reference with no definition nearby. Severity: advisory.

- Pattern: `\b(?:[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+|O\d(?:\s+KR\d)?|[A-Z]{2,6}-\d{1,6})\b`
- Exempt when the hit overlaps: `\b(?:CVE|RFC|ISO|UTF|SHA|PEP|WCAG|IEEE|ECMA|HTTP|MIME|ASCII|TLS|SSL|AES|RSA|MD)-?\d*\b`
- Exempt when this appears nearby: `\b(?:means|stands\s+for|short\s+for|called|named|known\s+as|defined\s+as)\b`, `\b(?:env(?:ironment)?\s+var\w*|variable|constant|flag|setting)\b`

### epistemic.evaluative

Vacuous evaluative word. Severity: scored, epistemic, weight 1.

- Terms: `cutting-edge`, `game-changing`, `innovative`, `optimal`, `groundbreaking`, `revolutionary`, `state-of-the-art`, `deep dive`, `world-class`, `best-in-class`, `next-generation`, `mission-critical`
- Exempt when the hit overlaps: `\boptimal\s+(?:solution|value|policy|substructure|control|stopping)\b`

### epistemic.presumed-context

Wording that assumes the reader saw earlier work. Severity: scored, epistemic, weight 1.5.

- Pattern: `\b(?:does\s+that\s+(?:match|look\s+right|work\s+for\s+you)|as\s+you\s+(?:saw|can\s+see|already\s+know)|as\s+we\s+discussed|you\s+(?:already\s+)?know\s+what\s+i\s+mean|the\s+earlier\s+(?:one|run|version))\b`

### epistemic.recap-opener

Recap opener that repeats instead of adding a fact. Severity: scored, epistemic, weight 1.5.

- Pattern: `(?<=^|[.!?]\s+)(?:overall|in\s+short|all\s+in\s+all|to\s+sum\s+up|ultimately),`

### epistemic.hedge-sibling

Hedge that may not match the evidence. Severity: scored, epistemic, weight 0.75.

- Pattern: `\b(?:presumably|i\s+believe|in\s+my\s+view|it\s+seems\s+to\s+indicate|appears\s+to\s+be|seems\s+to\s+be)\b`

### epistemic.vacuous-praise

Praise with no finding behind it. Severity: scored, epistemic, weight 2.

- Pattern: `\b(?:clean|great|solid|excellent)\s+separation\s+of\s+concerns\b|\bfollows\s+best\s+practices\b|\blgtm\b[!,.]?\s*(?:clean|great|nice|solid)\b`

### epistemic.canned-ops

Operations guidance with no executable step. Severity: scored, epistemic, weight 2.

- Pattern: `\brevert\s+if\s+(?:any\s+)?issues?\s+arise\b|\bstandard\s+deployment\b|\bno\s+special\s+(?:steps|handling)\s+(?:are\s+)?(?:needed|required)\b`

## Laundering

### laundering.compliance-narration

Narration of rule compliance instead of the content. Severity: hard.

- Pattern: `\bformatted\s+with\s+your\s+framing\b|\bas\s+(?:requested|instructed|you\s+(?:asked|requested|instructed)),?\s+(?:i\s+(?:have\s+|'ve\s+)?(?:avoided|removed|eliminated|ensured|kept|preserved|followed)|no\s+(?:em\s+)?dashes?)|\b(?:formatting|style|writing)\s+(?:guidelines|rules|constraints|instructions)\s+(?:strictly\s+|fully\s+)?(?:maintained|followed|preserved|applied|respected)\b|\bhere\s+is\s+the\s+(?:clean|cleaned|revised|rewritten|corrected)\s+version\b|\bwith\s+all\s+(?:the\s+)?(?:tells|slop|dashes|em\s+dashes|banned\s+\w+)\s+(?:removed|stripped|eliminated)\b|\bi\s+(?:have\s+)?(?:avoided|removed|eliminated|stripped)\s+(?:all\s+)?(?:the\s+)?(?:em\s+dashes|tells|slop|banned\s+\w+)\b|\bpreserved\b[^.\n]{1,60}[,;]\s*updated\b|\bi\s+(?:re-?read|reviewed|checked)\s+(?:my|the)\s+(?:reply|draft|response|text)\b[^.\n]{0,40}\b(?:no|without)\s+(?:issues|problems|tells|slop)\b`

### laundering.substitution

Thesaurus swap for a flagged phrase. Severity: scored, laundering, weight 2.5.

- Pattern: `\b(?:rich\s+mosaic|intricate\s+web|compelling\s+proof|enduring\s+(?:monument|evidence)|monumental\s+witness|scrutini[sz]e\s+thoroughly|probe\s+deeply|interconnected\s+matrix|central\s+axis|guiding\s+light|essential\s+pillar|vibrant\s+fabric|complex\s+ecosystem|instead\s+of\s+just|fulcral|linchpin)\b`

### laundering.false-colloquial

Fake informality at the start of a sentence. Severity: scored, laundering, weight 2.

- Pattern: `(?<=^|[.!?:]\s+)(?:look,|you\s+see,|here(?:\s+is|['\u2019]s)\s+the\s+(?:thing|kicker)\b|let['\u2019]s\s+be\s+(?:clear|real)\b|make\s+no\s+mistake\b|truth\s+be\s+told\b|to\s+be\s+clear\b|now\s+for\s+the\s+fun\s+part\b|the\s+plot\s+thickens\b)`

## Punctuation

### punctuation.em-dash

Em dash or horizontal bar used as a clause connector. Severity: hard.

- Pattern: `[\u2014\u2015\u2E3A\u2E3B]`

### punctuation.en-dash

En dash or figure dash in prose. Severity: hard.

- Pattern: `[\u2012\u2013]`

### punctuation.middle-dot

Middle dot used as a separator. Severity: hard.

- Pattern: `\s\u00B7\s`

### punctuation.zero-width

Zero-width character in text. Severity: hard.

- Pattern: `[\u200B-\u200D\u2060\uFEFF]`

### punctuation.quoted-name-parenthetical

Parenthetical that holds a quoted entity name. Severity: hard.

- Pattern: `\((?:the\s+)?["\u201C][^"\u201D)\n]{1,60}["\u201D](?:\s+[\p{L}-]+){0,3}\)`

### punctuation.semicolon

Semicolon joining clauses in prose. Severity: scored, laundering, weight 1; hard with --strict-semicolons.

- Pattern: `(?<=[\p{L}'\u2019"\u201D])\s?;(?=\s|$)`
- Exempt when the hit overlaps: `,[^;\n]{1,60};[^;\n]{1,60},`

### punctuation.spaced-hyphen

Spaced hyphen used as a dash. Severity: scored, laundering, weight 1.5.

- Pattern: `(?<=\p{L}{2})[ \t]+--?[ \t]+(?=\p{L}{2})`

### punctuation.double-hyphen

Double hyphen used as a dash. Severity: scored, laundering, weight 1.5.

- Pattern: `(?<=\p{L})--(?=\p{L})`

### punctuation.colon-label

Colon label at the start of a text unit. Severity: scored, laundering, weight 1.5.

- Pattern: `^(?:Status|Check|Result|Verdict|Finding|Findings|Outcome|Cause|Root cause|Decision|Summary|Takeaway|Impact|Risk|Why it matters|What changed|Next steps?|Action|Bottom line|Key finding|Key takeaway|Audit result|Risk factor|TL;DR|TLDR)[ \t]*:[ \t]+\S`

### punctuation.parenthetical-aside

Long parenthetical that demotes a fact. Severity: scored, laundering, weight 1.5.

- Pattern: `\((?:[^()\n]{35,}|[^()\n]*\b(?:which|without|avoiding|ensuring|meaning|rather|instead)\b[^()\n]{15,})\)`
- Exempt when the hit overlaps: `\(\s*(?:e\.g\.|i\.e\.|see\b|cf\.)`

## Structure

### structure.truncated-hex-id

Truncated identifier ending in an ellipsis. Severity: hard.

- Pattern: `\b(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){1,3}|(?=[0-9a-f]*\d)[0-9a-f]{8,40})(?:\.{3}|\u2026)`

### structure.meta-opener

Opener that describes the text instead of starting it. Severity: hard.

- Pattern: `\b(?:this\s+(?:document|page|ticket|journal|note|section|file)\s+(?:records|aims\s+to|seeks\s+to)\b|the\s+purpose\s+of\s+this\s+\w+\s+is\s+to\b|in\s+this\s+(?:section|document|post|article|guide|note),?\s+we(?:\s+will|'ll)?\b)`

### structure.bold-lead

Paragraph that opens with a bold label. Severity: scored, geometry, weight 1.5.

- Pattern: `^[ \t]*(?:\*\*[^*\n]{2,60}[:.]\*\*|\*\*[^*\n]{2,60}\*\*[:.])[ \t]+\S`

### structure.bot-heading

Template heading with no content of its own. Severity: scored, geometry, weight 2.

- Pattern: `^(?:Walkthrough|Changes at a Glance|Why This Matters|What Changed)[ \t]*:?[ \t]*$`

## Spelling

### spelling.ize-yze

American -ize/-yze spelling. Severity: advisory.

- Pattern: `\b\p{L}{2,}(?:iz(?:e|es|ed|ing|ation|ations|er|ers)|yz(?:e|es|ed|ing|er|ers))\b`
- Exempt when the hit overlaps: `\b(?:(?:re|down|up|over|under|right)?siz(?:e|es|ed|ing)|(?:pr|se|caps|ma|ba|ass)iz(?:e|es|ed|ing)|pfizer|seizure)\b`

### spelling.our

American -or spelling. Severity: advisory.

- Terms: `color*`, `behavior*`, `favor*`, `honor*`, `neighbor*`, `flavor*`, `labor*`, `harbor*`, `humor*`, `rumor*`, `vigor`, `odor`, `tumor`, `armor`, `candor`, `endeavor*`
- Exempt when the hit overlaps: `\bcolor\s*[:=]`

### spelling.centre

American spelling. Severity: advisory.

- Terms: `center*`, `fiber*`, `theater*`, `defense`, `offense`, `gray`, `catalog*`
- Exempt when the hit overlaps: `\b(?:text-align|align-items|justify-content|place-items)\b|\bcenter\s*[:;=]|\bgray\s*[:(=]`

## Times

### time.twenty-four-hour

24-hour time in prose. Severity: advisory.

- Pattern: `\b(?:1[3-9]|2[0-3]):[0-5]\d(?::[0-5]\d)?\b`

### time.utc-suffix

UTC or GMT time in prose. Severity: advisory.

- Pattern: `\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|GMT|Z)\b`

## Commit and review text

### commit.apologetic-leak

Review chat or apology recorded in commit history. Severity: hard.

- Pattern: `\b(?:address(?:ed|es|ing)?\s+(?:review\s+)?(?:feedback|comments)|per\s+(?:the\s+)?review(?:er)?|apologi[sz]\w*|my\s+(?:bad|mistake|oversight)|oversight|satisf\w+\s+(?:the\s+)?review)\b`

### commit.buzzword

Commit text states a virtue instead of the change. Severity: scored, epistemic, weight 2.5.

- Pattern: `\b(?:align(?:s|ing)?\s+with\s+best\s+practices?|industry[- ]standard|comprehensive\s+update|operational\s+stability|improv\w+\s+(?:robustness|maintainability|readability|modularity)|foster\w*\s+modularity|streamlin\w+\s+(?:the\s+)?architecture)\b`

### commit.speculative-value

Unfalsifiable value claim. Severity: scored, epistemic, weight 1.5.

- Pattern: `\b(?:fosters?|promotes?|ensures?|enhances?|improves?)\s+(?:code\s+)?(?:maintainability|readability|modularity|robustness|reliability|stability|scalability)\b`
