(ns marion.background.core
  (:require [cljs.core.async :refer [<! chan timeout go go-loop]]
            [oops.core :refer [oget ocall oapply]]
            [marion.background.logging :refer [log info warn error]]
            [marion.background.chrome :as chrome]
            [marion.background.dirac :as dirac]))

; -- main entry point -------------------------------------------------------------------------------------------------------

(defn init! []
  (log "init!")
  (chrome/start-event-loop!)
  (dirac/go-maintain-robust-connection-with-dirac-extension!))
