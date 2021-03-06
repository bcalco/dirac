(ns dirac.nrepl.config
  (:require [dirac.lib.utils :refer [read-env-config deep-merge-ignoring-nils]]
            [dirac.nrepl.config-helpers :refer [standard-repl-init-code default-reveal-url-request-handler!]]))

(def env-config-prefix "dirac-nrepl")

; you can override individual config keys via ENV variables, for example:
;   DIRAC_NREPL/LOG_LEVEL=debug or DIRAC_NREPL/WEASEL_REPL/RANGE=20
;
; see https://github.com/binaryage/env-config
(def default-config
  {:log-out                    :console                                                                                       ; this is important, nREPL middleware captures output and logs be sent to client
   :log-level                  "WARN"                                                                                         ; OFF, FATAL, ERROR, WARN, INFO, DEBUG, TRACE, ALL
   :weasel-repl                {:host       "localhost"
                                :port       8232
                                :port-range 10}                                                                               ; how many ports to try if the default port is taken
   ; dirac/sticky means we will inherit preferred compiler from old session on browser refresh
   :preferred-compiler         "dirac/sticky"                                                                                 ; or "dirac/new", or compiler matching strategy
   :cljs-repl-options          nil
   :repl-init-code             standard-repl-init-code
   :reveal-url-script-path     nil                                                                                            ; e.g. ".reveal.sh"
   :reveal-url-request-handler default-reveal-url-request-handler!                                                            ; using :reveal-url-script-path
   :runtime-tag                "unidentified"})

; -- config evaluation ------------------------------------------------------------------------------------------------------

(defn get-effective-config* [& [config]]
  (let [env-config (read-env-config env-config-prefix)]
    (deep-merge-ignoring-nils default-config env-config config)))

(def ^:dynamic get-effective-config (memoize get-effective-config*))                                                          ; assuming env-config is constant
