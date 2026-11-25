import Foundation
import Capacitor
#if canImport(ActivityKit)
import ActivityKit
#endif

/*
 * OPSİYONEL: iOS 16.2+ Kilit Ekranı Live Activity & Dynamic Island Eklentisi
 *
 * Not: Bu dosya olmadan da @capacitor/local-notifications (ID 9001) kilit ekranında
 * GPX kayıt bildirimini otomatik gösterir. iPhone kilit ekranında Apple Haritalar /
 * Strava gibi sabit "Canlı Etkinlik (Live Activity)" kartı isterseniz bu dosyayı
 * Xcode projenizdeki ios/App/App/ klasörüne ekleyip bir Widget Extension hedefi
 * oluşturabilirsiniz.
 */
#if canImport(ActivityKit)
@available(iOS 16.2, *)
public struct FlightRecordingAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var duration: String
        public var altitudeM: Int
        public var speedKmh: Int
        public var headingDeg: Int
    }

    public var callsign: String
    public var sim: Bool
}

@available(iOS 16.2, *)
@objc(FlightLiveActivityPlugin)
public class FlightLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FlightLiveActivityPlugin"
    public let jsName = "FlightLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var currentActivity: Activity<FlightRecordingAttributes>?

    @objc func start(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.resolve(["started": false])
            return
        }
        let attrs = FlightRecordingAttributes(
            callsign: call.getString("callsign") ?? "AviaDoX",
            sim: call.getBool("sim") ?? false
        )
        let state = FlightRecordingAttributes.ContentState(
            duration: call.getString("duration") ?? "00:00:00",
            altitudeM: call.getInt("altitudeM") ?? 0,
            speedKmh: call.getInt("speedKmh") ?? 0,
            headingDeg: call.getInt("headingDeg") ?? -1
        )
        do {
            currentActivity = try Activity.request(
                attributes: attrs,
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
            call.resolve(["started": true])
        } catch {
            call.reject("Live Activity başlatılamadı: \(error.localizedDescription)")
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let activity = currentActivity else {
            call.resolve(["updated": false])
            return
        }
        let state = FlightRecordingAttributes.ContentState(
            duration: call.getString("duration") ?? "00:00:00",
            altitudeM: call.getInt("altitudeM") ?? 0,
            speedKmh: call.getInt("speedKmh") ?? 0,
            headingDeg: call.getInt("headingDeg") ?? -1
        )
        Task {
            await activity.update(.init(state: state, staleDate: nil))
            call.resolve(["updated": true])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard let activity = currentActivity else {
            call.resolve(["stopped": true])
            return
        }
        currentActivity = nil
        Task {
            await activity.end(nil, dismissalPolicy: .immediate)
            call.resolve(["stopped": true])
        }
    }
}
#endif
