/** Width from which the sidebar is a persistent column; below it the sidebar is a drawer. style.css repeats this value in its max-width query, and a style test keeps the two equal. */
export const PERSISTENT_SIDEBAR_MIN_WIDTH = 1000;
export const persistentSidebarQuery = `(min-width: ${PERSISTENT_SIDEBAR_MIN_WIDTH}px)`;
