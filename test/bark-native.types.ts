/** Compile with the optional native peer installed; never execute on Node. */
import type * as SDK from '@secondts/bark-react-native'
import type { NativeBarkModule } from '../src/backends/bark-native.js'
declare const sdk: typeof SDK
const compatible: NativeBarkModule = sdk
void compatible
