/// Decides when the keyboard moves between the composer and a view that Pi shows in its terminal.
///
/// Pi marks a view that opened in answer to a command sent from the composer, such as the view of
/// `/stash`. The keyboard follows such a view while the composer still holds it. Any other view,
/// such as a question from a running tool, leaves the keyboard where it is. When a view that holds
/// the keyboard because of the composer closes, the composer takes the keyboard back.
struct ComposerHandoff: Equatable {
    enum Move: Equatable {
        case none
        /// Give the keyboard to Pi's terminal.
        case release
        /// Take the keyboard back from Pi's terminal.
        case reclaim
    }

    private(set) var waiting = false
    /// The composer gave the keyboard to the current view, or the operator moved it there.
    private(set) var released = false

    mutating func update(waiting value: Bool, answersComposer: Bool, composerHasKeyboard: Bool) -> Move {
        guard value != waiting else { return .none }
        waiting = value
        if value {
            guard answersComposer, composerHasKeyboard else { return .none }
            released = true
            return .release
        }
        guard released else { return .none }
        released = false
        return .reclaim
    }

    /// The operator moved the keyboard to the terminal while Pi shows a view there.
    mutating func operatorReleased() {
        if waiting { released = true }
    }
}
