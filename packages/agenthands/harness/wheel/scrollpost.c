// Posts real macOS scroll-wheel CGEvents so the browser receives them through
// the genuine NSEvent path (web_input_event_builders_mac.mm), which is the only
// way to observe what phase/momentumPhase a hardware trackpad actually delivers
// to a page. CDP has no parameter for either field.
//
// Usage: scrollpost <pid> <x> <y>
// Then one gesture step per stdin line: <scrollPhase> <momentumPhase> <deltaPx> <sleepMs>
// scrollPhase: 0 none, 1 began, 2 changed, 4 ended
// momentumPhase: 0 none, 1 begin, 2 continue, 3 end
//
// clang -framework CoreGraphics -framework CoreFoundation -o scrollpost scrollpost.c

#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

enum {
  kFieldDeltaAxis1 = 11,
  kFieldIsContinuous = 88,
  kFieldFixedPtDeltaAxis1 = 93,
  kFieldPointDeltaAxis1 = 96,
  kFieldScrollPhase = 99,
  kFieldScrollCount = 100,
  kFieldMomentumPhase = 123,
};

int main(int argc, char** argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: %s <pid> <x> <y>\n", argv[0]);
    return 2;
  }
  pid_t pid = (pid_t)atoi(argv[1]);
  double x = atof(argv[2]);
  double y = atof(argv[3]);

  if (!AXIsProcessTrusted()) {
    fprintf(stderr, "NOT_TRUSTED: this process lacks Accessibility permission; "
                    "posted events will be dropped\n");
  }

  // "hid" posts to the HID event tap, the same queue physical hardware feeds,
  // and warps the cursor over the target point first because AppKit routes a
  // scroll to the window under the pointer. "pid" targets one process without
  // moving the cursor, which does not deliver scrolls at all.
  int hid = argc > 4 && argv[4][0] == 'h';
  // Line units and no IsContinuous flag is what a notched USB wheel produces on
  // macOS: web_input_event_builders_mac.mm takes its else branch, leaving
  // delta_units at kScrollByPixel instead of kScrollByPrecisePixel.
  int line_units = argc > 5 && argv[5][0] == 'l';
  CGPoint restore = CGPointZero;
  if (hid) {
    CGEventRef probe = CGEventCreate(NULL);
    restore = CGEventGetLocation(probe);
    CFRelease(probe);
    CGWarpMouseCursorPosition(CGPointMake(x, y));
    CGAssociateMouseAndMouseCursorPosition(true);
    usleep(150000);
  }

  CGEventSourceRef src =
      CGEventSourceCreate(kCGEventSourceStateHIDSystemState);

  int phase, momentum, sleep_ms;
  double delta;
  int posted = 0;
  while (scanf("%d %d %lf %d", &phase, &momentum, &delta, &sleep_ms) == 4) {
    // Pixel units mark the event continuous, which is what a trackpad is.
    CGEventRef e = CGEventCreateScrollWheelEvent2(
        src, line_units ? kCGScrollEventUnitLine : kCGScrollEventUnitPixel, 1,
        (int32_t)delta, 0, 0);
    CGEventSetLocation(e, CGPointMake(x, y));
    if (!line_units) CGEventSetIntegerValueField(e, kFieldIsContinuous, 1);
    CGEventSetIntegerValueField(e, kFieldScrollPhase, phase);
    CGEventSetIntegerValueField(e, kFieldMomentumPhase, momentum);
    if (!line_units) {
      CGEventSetIntegerValueField(e, kFieldPointDeltaAxis1, (int64_t)delta);
      CGEventSetIntegerValueField(e, kFieldFixedPtDeltaAxis1,
                                  (int64_t)(delta * 65536.0));
    }
    if (phase == 1) CGEventSetIntegerValueField(e, kFieldScrollCount, 1);
    if (hid) {
      CGEventPost(kCGHIDEventTap, e);
    } else {
      CGEventPostToPid(pid, e);
    }
    CFRelease(e);
    posted++;
    if (sleep_ms > 0) usleep((useconds_t)sleep_ms * 1000);
  }
  if (hid) CGWarpMouseCursorPosition(restore);
  CFRelease(src);
  fprintf(stderr, "posted %d\n", posted);
  return 0;
}
