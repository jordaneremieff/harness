import Foundation

struct SyntaxLexicon {
    let language: SyntaxLanguage
    let storage: Set<String>
    let keywords: Set<String>
    let constants: Set<String>
    let types: Set<String>
    let quoteMarks: Set<UInt16>
    let lineComment: [UInt16]
    let commentOpen: [UInt16]
    let commentClose: [UInt16]
    let flags: Flags

    struct Flags: OptionSet {
        let rawValue: UInt32
        static let js = Self(rawValue: 1 << 0)
        static let jsx = Self(rawValue: 1 << 1)
        static let swift = Self(rawValue: 1 << 2)
        static let python = Self(rawValue: 1 << 3)
        static let shell = Self(rawValue: 1 << 4)
        static let markup = Self(rawValue: 1 << 5)
        static let yaml = Self(rawValue: 1 << 6)
        static let toml = Self(rawValue: 1 << 7)
        static let json = Self(rawValue: 1 << 8)
        static let data = Self(rawValue: 1 << 9)
        static let nestedComment = Self(rawValue: 1 << 10)
        static let sql = Self(rawValue: 1 << 11)
        static let rust = Self(rawValue: 1 << 12)
        static let cFamily = Self(rawValue: 1 << 13)
        static let css = Self(rawValue: 1 << 14)
        static let dashWord = Self(rawValue: 1 << 15)
        static let dollarWord = Self(rawValue: 1 << 16)
        static let triple = Self(rawValue: 1 << 17)
        static let backtick = Self(rawValue: 1 << 18)
        static let annotation = Self(rawValue: 1 << 19)
    }

    private init(_ id: String, _ storage: String = "", _ keywords: String = "", types: String = "",
                 constants: String = "true false null", quotes: String = "\"'", flags: Flags = []) {
        language = SyntaxLanguage.named(id)!
        self.storage = Self.words(storage)
        self.keywords = Self.words(keywords)
        self.constants = Self.words(constants)
        self.types = Self.words(types)
        quoteMarks = Set(quotes.utf16)
        lineComment = Array((language.lineComment ?? "").utf16)
        commentOpen = Array((language.blockComment?.open ?? "").utf16)
        commentClose = Array((language.blockComment?.close ?? "").utf16)
        self.flags = flags
    }

    private static func words(_ text: String) -> Set<String> { Set(text.split(separator: " ").map(String.init)) }

    private static let control = "if else for while do break continue switch case default return throw try catch finally"
    private static let cStorage = "auto const enum extern inline register static struct typedef union volatile restrict _Atomic"
    private static let cTypes = "bool char double float int long short signed unsigned void size_t wchar_t"
    private static let jsStorage = "abstract accessor class const declare enum export extends function implements import interface let namespace override package private protected public readonly static type var"
    private static let jsWords = control + " as async await debugger delete in instanceof keyof new of satisfies super this typeof void with yield infer is asserts"
    private static let jsTypes = "any bigint boolean never number object string symbol unknown Array BigInt Boolean Date Error Map Number Object Promise Record RegExp Set String Symbol WeakMap WeakSet"

    private static let profiles: [String: Self] = {
        let js = ["typescript", "tsx", "javascript", "jsx"].map { id in
            Self(id, jsStorage, jsWords, types: jsTypes, constants: "true false null undefined NaN Infinity",
                 flags: ["tsx", "jsx"].contains(id) ? [.js, .jsx, .dollarWord, .annotation] : [.js, .dollarWord, .annotation])
        }
        let rest = [
            Self("plain", quotes: ""), Self("markdown", quotes: ""), Self("diff", quotes: ""), Self("git-commit", quotes: ""),
            Self("swift", "actor associatedtype case class convenience deinit didSet distributed dynamic enum extension fileprivate final func get import indirect init internal isolated lazy let mutating nonisolated nonmutating open operator override package private protocol public required set static struct subscript typealias var weak willSet", "as async await borrowing break catch consume consuming continue default defer do else fallthrough for guard if in inout is repeat rethrows return some any super switch throw throws try where while yield", types: "Any AnyObject Array Bool Character Dictionary Double Float Int Int8 Int16 Int32 Int64 Never Optional Result Set String UInt UInt8 UInt16 UInt32 UInt64 Void", constants: "true false nil self Self", quotes: "\"", flags: [.swift, .triple, .nestedComment, .annotation, .dollarWord]),
            Self("python", "class def from global import nonlocal", "and as assert async await break case continue del elif else except finally for if in is lambda match not or pass raise return try while with yield", types: "bool bytes bytearray complex dict float frozenset int list memoryview object range set str tuple type", constants: "True False None NotImplemented Ellipsis self cls", flags: [.python, .triple, .annotation]),
            Self("bash", "export function local readonly typeset declare", "if elif else then fi for do done in case esac while until select time coproc break continue return source unset trap", flags: [.shell, .backtick, .dashWord]),
            Self("zsh", "export function local readonly typeset declare", "if elif else then fi for do done in case esac while until repeat select time break continue return source unset trap", flags: [.shell, .backtick, .dashWord]),
            Self("fish", "function set", "and begin break builtin case command continue else end eval exec for if not or return source switch test while", flags: [.shell, .dashWord]),
            Self("json", quotes: "\"", flags: [.json, .data]), Self("jsonc", quotes: "\"", flags: [.json, .data]),
            Self("yaml", constants: "true false null True False Null TRUE FALSE NULL ~", flags: [.yaml, .data, .dashWord]),
            Self("toml", constants: "true false inf nan", flags: [.toml, .triple, .data, .dashWord]),
            Self("ini", constants: "true false yes no on off", flags: [.data, .dashWord]),
            Self("dotenv", "export", flags: [.data]),
            Self("css", "", "important", flags: [.css, .dashWord, .annotation]),
            Self("scss", "", "important", flags: [.css, .dashWord, .dollarWord, .annotation]),
            Self("html", flags: [.markup]), Self("xml", flags: [.markup]), Self("svg", flags: [.markup]),
            Self("sql", "alter create database drop function index procedure schema table trigger view", "all and as asc between by case check delete desc distinct else end exists from full group having in inner insert into is join left limit like not null offset on or order outer returning right select set then truncate union update using values when where with", types: "bigint boolean char date decimal double int integer json jsonb numeric real smallint text time timestamp uuid varchar", flags: [.sql, .nestedComment]),
            Self("rust", "const crate dyn enum extern fn impl let mod move mut pub ref static struct trait type union unsafe use", "as async await break continue else for if in loop match return super where while", types: "bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result", constants: "true false self Self None Some Ok Err", flags: [.rust, .nestedComment]),
            Self("go", "const func import interface map package struct type var", control + " chan defer fallthrough go goto range select", types: "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr", constants: "true false iota nil", flags: [.backtick]),
            Self("c", cStorage, control + " goto sizeof _Alignof _Generic", types: cTypes, constants: "true false NULL nullptr", flags: [.cFamily]),
            Self("cpp", cStorage + " class concept constexpr consteval constinit explicit friend mutable namespace noexcept private protected public template typename using virtual", control + " alignof and co_await co_return co_yield delete goto new not or requires sizeof this", types: cTypes + " char8_t char16_t char32_t string vector", constants: "true false NULL nullptr", flags: [.cFamily]),
            Self("objc", cStorage, control + " goto sizeof self super", types: cTypes + " BOOL id NSString NSUInteger NSInteger", constants: "YES NO nil Nil NULL true false", flags: [.annotation, .cFamily]),
            Self("java", "abstract class enum extends final implements import interface native package private protected public record sealed static strictfp synchronized transient var volatile", control + " assert instanceof new super this throws yield", types: "boolean byte char double float int long short void String Object Integer List Map", flags: [.annotation, .triple]),
            Self("kotlin", "abstract annotation class companion const constructor data enum expect external final fun import inline interface internal lateinit object open override package private protected public sealed suspend typealias val var", "as break catch continue do else finally for if in is return super this throw try when while", types: "Any Boolean Byte Char Double Float Int Long Nothing Short String Unit", flags: [.annotation, .triple, .nestedComment]),
            Self("csharp", "abstract class const delegate enum event extern interface internal namespace override partial private protected public readonly record sealed static struct unsafe using var virtual volatile", control + " as async await checked foreach goto in is lock new out ref sizeof stackalloc this typeof unchecked when yield", types: "bool byte char decimal double float int long nint nuint object sbyte short string uint ulong ushort void", flags: [.cFamily, .triple]),
            Self("ruby", "class def module private protected public require require_relative attr_reader attr_writer attr_accessor", "alias and begin break case do else elsif end ensure for if in next not or redo rescue retry return super then undef unless until when while yield", types: "Array Class Hash Integer Module Numeric Object Proc String Symbol", constants: "true false nil self", flags: [.annotation]),
            Self("php", "abstract class const declare enum final function global interface namespace private protected public readonly static trait use var", control + " and as clone echo foreach in instanceof new or print require include yield", types: "array bool callable float int iterable mixed never object string void", flags: [.dollarWord]),
            Self("lua", "function local", "and break do else elseif end for goto if in not or repeat return then until while", constants: "true false nil"),
            Self("dockerfile", "add arg cmd copy entrypoint env expose from healthcheck label maintainer onbuild run shell stopsignal user volume workdir", flags: [.dashWord]),
            Self("makefile", "define export include override private sinclude undefine unexport vpath", "else endef endif ifdef ifeq ifndef ifneq", flags: [.data, .dashWord]),
        ]
        return Dictionary(uniqueKeysWithValues: (js + rest).map { ($0.language.id, $0) })
    }()

    static func profile(_ language: String) -> Self { profiles[language] ?? profiles["plain"]! }
}
