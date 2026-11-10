// Imported first by entry-staging.ts, so the lock is in place before any other module is evaluated.
import { lockEgress } from "./egress";

lockEgress();
