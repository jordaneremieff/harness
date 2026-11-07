/**
 * Bounds for discovered page links. The schema, the link collector and the reader share these
 * values without evaluating the HTML parser.
 */
export const PAGE_LINK_LIMITS = Object.freeze({ records: 2048, bytes: 256 * 1024, labelCharacters: 512, perPage: 160 });
