import Foundation
import Network

enum Route: String, CaseIterable, Sendable {
    case connect = "/connect"
    case poll = "/poll"
    case catalogue = "/catalogue"
    case edit = "/edit"
    case tools = "/tools"
    case toolsApply = "/tools/apply"
    case close = "/close"
}

private final class LocalBridgeDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        (.cancelAuthenticationChallenge, nil)
    }
}

final class Transport: Sendable {
    private static let requestLimit = 1_048_576 // BRIDGE_REQUEST_BYTES
    private static let responseLimit = 16 * 1_048_576
    private let capability: Capability
    private let session: URLSession
    private let client = UUID().uuidString.lowercased()

    init(capability: Capability) {
        self.capability = capability
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.proxyConfigurations = []
        configuration.timeoutIntervalForResource = 35
        session = URLSession(configuration: configuration, delegate: LocalBridgeDelegate(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    @concurrent
    func post(_ route: Route, _ bytes: Data) async throws -> Data {
        let tooLarge = ConfigFailure("The Config request is too large.")
        guard bytes.count <= Self.requestLimit else { throw tooLarge }
        guard var fields = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else {
            throw ConfigFailure("Invalid Config request.")
        }
        fields["client"] = client
        let body = try JSONSerialization.data(withJSONObject: fields)
        guard body.count <= Self.requestLimit else { throw tooLarge }
        var request = capability.authorize(route)
        request.timeoutInterval = route == .poll ? 30 : 10
        request.httpBody = body

        let unavailable = ConfigFailure("The Config request did not complete. Check the session before you retry.")
        let incoming: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (incoming, response) = try await session.bytes(for: request)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            // Foundation errors can carry request details. Never expose them to the page.
            throw unavailable
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            incoming.task.cancel()
            throw unavailable
        }
        let responseTooLarge = ConfigFailure("The Config reply is too large.")
        guard response.expectedContentLength <= Self.responseLimit else {
            incoming.task.cancel()
            throw responseTooLarge
        }
        var reply = Data()
        do {
            for try await byte in incoming {
                guard reply.count < Self.responseLimit else {
                    incoming.task.cancel()
                    throw responseTooLarge
                }
                reply.append(byte)
            }
        } catch let refusal as ConfigFailure {
            throw refusal
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw unavailable
        }
        return reply
    }
}
