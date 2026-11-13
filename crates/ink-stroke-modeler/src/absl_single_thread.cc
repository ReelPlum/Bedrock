// The browser runs Bedrock's WebAssembly on one thread, so abseil's mutex
// has nothing to guard there and the machine has one CPU. abseil's own
// mutex.cc and sysinfo.cc need threads and system calls WASI lacks, so
// these stand in for them.
#include "absl/base/internal/sysinfo.h"
#include "absl/synchronization/mutex.h"

namespace absl {
ABSL_NAMESPACE_BEGIN
void Mutex::Lock() {}
void Mutex::Unlock() {}
namespace base_internal {
int NumCPUs() { return 1; }
}  // namespace base_internal
ABSL_NAMESPACE_END
}  // namespace absl
