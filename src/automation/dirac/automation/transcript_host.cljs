(ns dirac.automation.transcript-host
  (:require-macros [cljs.core.async.macros :refer [go go-loop]]
                   [dirac.settings :refer [get-test-dirac-agent-port get-transcript-match-timeout]])
  (:require [cljs.core.async :refer [put! <! chan timeout alts! close!]]
            [cljs.core.async.impl.protocols :as core-async]
            [dirac.automation.transcript :as transcript]
            [chromex.support :refer-macros [oget oset ocall oapply]]
            [chromex.logging :refer-macros [log warn error info]]
            [cuerdas.core :as cuerdas]
            [dirac.automation.helpers :as helpers]
            [dirac.utils :as utils]))

(defonce current-transcript (atom nil))
(defonce transcript-observers (atom #{}))
(defonce sniffer-enabled (atom true))
(defonce ^:dynamic *transcript-enabled* true)

(defn ^:dynamic get-timeout-transcript [max-waiting-time re]
  (str "while waiting (" max-waiting-time "ms) for transcript match: " re))

(defn add-transcript-observer! [observer]
  {:pre [(not (contains? @transcript-observers observer))]}
  (swap! transcript-observers conj observer))

(defn remove-transcript-observer! [observer]
  {:pre [(contains? @transcript-observers observer)]}
  (swap! transcript-observers disj observer))

(defn init-transcript! [id]
  (let [transcript-el (transcript/create-transcript! (helpers/get-el-by-id id))]
    (reset! current-transcript transcript-el)))

(defn has-transcript? []
  (not (nil? @current-transcript)))

(defn disable-transcript! []
  (set! *transcript-enabled* false))

(defn set-style! [style]
  (ocall js/window "setRunnerFavicon" style)
  (transcript/set-style! @current-transcript style))

(defn sniffer-enabled? []
  @sniffer-enabled)

(defn disable-sniffer! []
  (if-not (sniffer-enabled?)
    (do
      (warn "sniffer is already disabled")
      (.trace js/console))
    (reset! sniffer-enabled false)))

(defn enable-sniffer! []
  (if (sniffer-enabled?)
    (do
      (warn "sniffer is already enabled")
      (.trace js/console))
    (reset! sniffer-enabled false)))

(defn call-transcript-sniffer [text]
  (doseq [observer @transcript-observers]
    (observer observer text)))

(defn format-transcript-line [label text]
  {:pre [(string? text)
         (string? label)]}
  (let [padded-type (cuerdas/pad label {:length 16 :type :right})]
    (str padded-type " " text)))

(defn append-to-transcript! [label text & [force?]]
  {:pre [(has-transcript?)
         (string? text)
         (string? label)]}
  (if (sniffer-enabled?)
    (call-transcript-sniffer text))
  (if (or *transcript-enabled* force?)
    (transcript/append-to-transcript! @current-transcript (str (format-transcript-line label text) "\n"))))

(defn read-transcript []
  {:pre [(has-transcript?)]}
  (transcript/read-transcript @current-transcript))

(defn without-transcript-work [worker]
  (binding [*transcript-enabled* false]
    (worker)))

(defn wait-for-transcript-match
  ([re]
   (wait-for-transcript-match re nil))
  ([re time-limit]
   (wait-for-transcript-match re time-limit false))
  ([re time-limit silent?]
   (let [result-channel (chan)
         max-waiting-time (or time-limit (get-transcript-match-timeout))
         timeout-channel (timeout max-waiting-time)
         observer (fn [self text]
                    (when-let [match (re-matches re text)]
                      (remove-transcript-observer! self)
                      (put! result-channel match)))]
     (add-transcript-observer! observer)
     (go
       (let [[result] (alts! [result-channel timeout-channel])]
         (or result
             (if silent?
               :timeout
               (do
                 (disable-sniffer!)
                 (throw (ex-info :task-timeout {:transcript (get-timeout-transcript max-waiting-time re)}))))))))))