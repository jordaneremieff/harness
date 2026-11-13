// Importers of the core see Foundation through it. The test targets rely on this: a test file
// that imports both Testing and Foundation needs the `_Testing_Foundation` cross-import module,
// which the Command Line Tools ship without its module interface. Test files therefore import
// Testing first and then the core with `@testable`, and never Foundation directly.
@_exported import Foundation
