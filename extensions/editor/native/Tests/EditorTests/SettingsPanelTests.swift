import Testing
@testable import Editor

@MainActor
struct SettingsPanelTests {
    @Test func typedFieldsValidateNumbersAndColumnLists() throws {
        let size = try #require(EditorSettings.specsByKey["fontSize"])
        #expect(size.fieldValue("16") == .number(16))
        #expect(size.fieldValue("50") == nil)
        #expect(size.fieldValue("NaN") == nil)
        #expect(size.fieldValue("16px") == nil)
        let rulers = try #require(EditorSettings.specsByKey["rulers"])
        #expect(rulers.fieldValue(" 80, 120 ") == .columns([80, 120]))
        #expect(rulers.fieldValue("") == .columns([]))
        #expect(rulers.fieldValue("80.5, 120") == nil)
        #expect(rulers.fieldValue("80,") == nil)
        #expect(rulers.fieldValue("1001") == nil)
    }
}
