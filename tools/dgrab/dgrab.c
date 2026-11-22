/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * dgrab.c: Grabs a region of an X screen only when it changes, and writes it out as constant-rate raw bgr0 frames for an FFmpeg encoder's stdin.
 *
 *   dgrab DISPLAY X Y WIDTH HEIGHT RATE_NUM RATE_DEN [SECONDS]
 *
 * Why: x11grab samples the screen on FFmpeg's clock while Chrome presents video frames on its own, so a sample near a frame change catches it twice or misses
 * it. Oversampling at twice the rate and dropping repeats (the grab smoothing filter) fixes that, but the repeat check needs the frames converted to YUV on the
 * CPU - about 0.4 of a core per 30 fps stream. dgrab grabs each frame once, right after Chrome draws it, and hands NVENC the RGB, which it converts on the GPU.
 *
 * How: DAMAGE on the root window reports every drawing on the screen. When a report touches the region, dgrab waits for the burst of reports that make up one
 * presented frame to settle (SETTLE_US with no new report in the region, at most MAX_SETTLE_US), copies the region once with XShmGetImage, and queues it
 * unless its pixels equal the newest grab's (a redraw that changed nothing is not a frame). A
 * clock ticking at RATE_NUM/RATE_DEN writes one frame per tick: the oldest queued new frame, or the previous one again when nothing new arrived. The queue holds
 * QUEUE frames; a fuller queue drops its oldest (a skip). The first grab is written at once and the clock starts when the reader has taken it, one tick later,
 * so a frame presented a little late still meets its tick and nothing grabbed while the reader was starting sits ahead of it. A writer thread drains the output,
 * so a reader that is slow for a moment never delays a grab. Every tick becomes a frame: the encoder numbers frames rather than reading their time, and its
 * audio follows the wall clock, so a tick left out would put the sound behind the picture for good. A tick that finds OUT_PENDING frames waiting is owed
 * as one more copy of the newest of them, and so are the ticks missed while this process was held up. The region is grabbed at start and at least once a second even
 * with no reports, so a still screen still produces frames.
 *
 * Exits when stdout closes, after SECONDS when given, or on SIGTERM. Counters go to stderr every five minutes and at exit.
 */
#define _GNU_SOURCE
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xdamage.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <time.h>
#include <unistd.h>

#define QUEUE 3
#define OUT 8

// Frames waiting for the reader beyond this are not queued: their ticks are owed as copies of the newest one waiting (counted as output full).
#define OUT_PENDING 2
#define SETTLE_US 1500
#define MAX_SETTLE_US 6000
#define REFRESH_US 1000000
#define REPORT_US 300000000LL

static int64_t now_us(void) {

  struct timespec ts;

  clock_gettime(CLOCK_MONOTONIC, &ts);

  return ((int64_t)ts.tv_sec * 1000000) + (ts.tv_nsec / 1000);
}

static int write_all(const uint8_t *p, size_t n) {

  while(n) {

    ssize_t w = write(1, p, n);

    if(w < 0) {

      if(errno == EINTR) {

        continue;
      }

      return -1;
    }

    p += w;
    n -= (size_t)w;
  }

  return 0;
}

// The output ring: a tick copies a frame in, the writer thread drains it to stdout. out_done is 1 at the end of input, 2 once stdout has closed.
static uint8_t *out_ring[OUT];
static int out_head = 0, out_len = 0, out_done = 0, out_started = 0;
static size_t out_bytes;
static int64_t out_copies[OUT];
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t out_cond = PTHREAD_COND_INITIALIZER;

static void *writer(void *arg) {

  (void)arg;

  for(;;) {

    pthread_mutex_lock(&out_lock);

    while(!out_len && !out_done) {

      pthread_cond_wait(&out_cond, &out_lock);
    }

    if(!out_len) {

      pthread_mutex_unlock(&out_lock);

      return NULL;
    }

    uint8_t *frame = out_ring[out_head];

    pthread_mutex_unlock(&out_lock);

    int failed = write_all(frame, out_bytes) < 0;

    pthread_mutex_lock(&out_lock);

    if(failed) {

      out_done = 2;
      pthread_mutex_unlock(&out_lock);

      return NULL;
    }

    out_started = 1;

    // The same frame again for each tick owed on it, unless the input is over.
    if((out_copies[out_head] > 0) && !out_done) {

      out_copies[out_head]--;
    } else {

      out_copies[out_head] = 0;
      out_head = (out_head + 1) % OUT;
      out_len--;
    }

    pthread_mutex_unlock(&out_lock);
  }
}

// Queues a frame for the writer, standing for the given number of ticks. Answers -1 once stdout has closed, 1 when the ring was full and the ticks were owed
// on the newest frame waiting instead, 0 otherwise.
static int emit(const uint8_t *frame, int64_t ticks) {

  pthread_mutex_lock(&out_lock);

  if(out_done == 2) {

    pthread_mutex_unlock(&out_lock);

    return -1;
  }

  if(out_len >= OUT_PENDING) {

    out_copies[(out_head + out_len - 1) % OUT] += ticks;
    pthread_mutex_unlock(&out_lock);

    return 1;
  }

  int slot = (out_head + out_len) % OUT;

  pthread_mutex_unlock(&out_lock);
  memcpy(out_ring[slot], frame, out_bytes);
  pthread_mutex_lock(&out_lock);
  out_copies[slot] = ticks - 1;
  out_len++;
  pthread_cond_signal(&out_cond);
  pthread_mutex_unlock(&out_lock);

  return 0;
}

static volatile sig_atomic_t stopping = 0;

static void on_term(int sig) {

  (void)sig;
  stopping = 1;
}

int main(int argc, char **argv) {

  if(argc < 8) {

    fprintf(stderr, "usage: dgrab DISPLAY X Y WIDTH HEIGHT RATE_NUM RATE_DEN [SECONDS]\n");

    return 2;
  }

  int rx = atoi(argv[2]), ry = atoi(argv[3]), rw = atoi(argv[4]), rh = atoi(argv[5]);
  int64_t num = atoll(argv[6]), den = atoll(argv[7]);
  double seconds = (argc > 8) ? atof(argv[8]) : 0;

  if((rw <= 0) || (rh <= 0) || (num <= 0) || (den <= 0)) {

    fprintf(stderr, "dgrab: bad region or rate\n");

    return 2;
  }

  signal(SIGPIPE, SIG_IGN);
  signal(SIGTERM, on_term);
  signal(SIGINT, on_term);

  Display *dpy = XOpenDisplay(argv[1]);

  if(!dpy) {

    fprintf(stderr, "dgrab: cannot open display %s\n", argv[1]);

    return 1;
  }

  int dmg_event, dmg_error;

  if(!XDamageQueryExtension(dpy, &dmg_event, &dmg_error) || !XShmQueryExtension(dpy)) {

    fprintf(stderr, "dgrab: the display has no DAMAGE or MIT-SHM extension\n");

    return 1;
  }

  Window root = DefaultRootWindow(dpy);
  Damage damage = XDamageCreate(dpy, root, XDamageReportRawRectangles);
  XShmSegmentInfo shm;
  XImage *img = XShmCreateImage(dpy, DefaultVisual(dpy, DefaultScreen(dpy)), (unsigned int)DefaultDepth(dpy, DefaultScreen(dpy)), ZPixmap, NULL, &shm,
    (unsigned int)rw, (unsigned int)rh);

  if(!img || (img->bits_per_pixel != 32)) {

    fprintf(stderr, "dgrab: the display is not 32 bits per pixel\n");

    return 1;
  }

  shm.shmid = shmget(IPC_PRIVATE, (size_t)img->bytes_per_line * (size_t)rh, IPC_CREAT | 0600);
  shm.shmaddr = img->data = shmat(shm.shmid, NULL, 0);
  shm.readOnly = False;
  XShmAttach(dpy, &shm);
  XSync(dpy, False);
  shmctl(shm.shmid, IPC_RMID, NULL);

  size_t row_bytes = (size_t)rw * 4, frame_bytes = row_bytes * (size_t)rh;
  uint8_t *queue[QUEUE], *last = calloc(1, frame_bytes);

  for(int i = 0; i < QUEUE; i++) {

    queue[i] = malloc(frame_bytes);
  }

  out_bytes = frame_bytes;

  for(int i = 0; i < OUT; i++) {

    out_ring[i] = malloc(frame_bytes);
  }

  pthread_t writer_thread;

  pthread_create(&writer_thread, NULL, writer, NULL);

  long grabs = 0, unchanged = 0, reports = 0, written = 0, repeats = 0, drops = 0, out_full = 0;
  int qhead = 0, qlen = 0, have_last = 0, primed = 0;
  int64_t start = now_us(), pending_since = start, last_report = start, last_grab = start, next_tick = -1, tick0 = 0, tick_n = 0, next_stats = start + REPORT_US;
  int fd = ConnectionNumber(dpy);

  while(!stopping) {

    int64_t t = now_us();

    if((seconds > 0) && ((t - start) > (int64_t)(seconds * 1e6))) {

      break;
    }

    // A still region produces no reports; grab it anyway now and then.
    if((pending_since < 0) && ((t - last_grab) >= REFRESH_US)) {

      pending_since = last_report = t - SETTLE_US;
    }

    // Grab once the burst of reports for the region has settled.
    if((pending_since >= 0) && (((t - last_report) >= SETTLE_US) || ((t - pending_since) >= MAX_SETTLE_US))) {

      XShmGetImage(dpy, root, img, rx, ry, AllPlanes);
      grabs++;
      last_grab = now_us();
      pending_since = -1;

      // A drawing that left the region's pixels as they were is not a new frame. Pages redraw small elements over the video (Prime Video repaints a spinner
      // about 15 times a second); queued, those copies crowded real frames out of the queue. The newest grab is the queue's last entry, or the last frame
      // written when the queue is empty. A real frame differs within the first rows, so the comparison is short except for the copies it catches.
      if(have_last) {

        const uint8_t *newest = qlen ? queue[(qhead + qlen - 1) % QUEUE] : last;
        int same = 1;

        for(int y = 0; same && (y < rh); y++) {

          same = !memcmp(newest + ((size_t)y * row_bytes), img->data + ((size_t)y * (size_t)img->bytes_per_line), row_bytes);
        }

        if(same) {

          unchanged++;

          continue;
        }
      }

      if(qlen == QUEUE) {

        qhead = (qhead + 1) % QUEUE;
        qlen--;
        drops++;
      }

      uint8_t *dst = queue[(qhead + qlen) % QUEUE];

      for(int y = 0; y < rh; y++) {

        memcpy(dst + ((size_t)y * row_bytes), img->data + ((size_t)y * (size_t)img->bytes_per_line), row_bytes);
      }

      qlen++;

      // The first grab goes straight out. The clock starts once the reader has taken it (below), so frames grabbed while FFmpeg was still starting up
      // never sit in front of it as a standing delay.
      if(!primed) {

        memcpy(last, queue[qhead], frame_bytes);
        qhead = (qhead + 1) % QUEUE;
        qlen--;
        have_last = primed = 1;

        if(emit(last, 1) < 0) {

          break;
        }

        written++;
      }
    }

    if(primed && (next_tick < 0)) {

      pthread_mutex_lock(&out_lock);

      int started = out_started;

      pthread_mutex_unlock(&out_lock);

      if(started) {

        tick0 = next_tick = now_us() + ((1000000 * den) / num);
        tick_n = 0;

        // Keep only the newest grab: anything older was drawn before the reader was there.
        while(qlen > 1) {

          qhead = (qhead + 1) % QUEUE;
          qlen--;
        }
      }
    }

    // Write one frame per tick.
    t = now_us();

    if((next_tick >= 0) && (t >= next_tick)) {

      if(qlen) {

        memcpy(last, queue[qhead], frame_bytes);
        qhead = (qhead + 1) % QUEUE;
        qlen--;
        have_last = 1;
      } else if(have_last) {

        repeats++;
      }

      // This tick, and any missed while held up for over a tenth of a second: those become copies rather than a burst of loop turns.
      int64_t ticks = 1;

      if((t - next_tick) > 100000) {

        ticks += ((t - next_tick) * num) / (1000000 * den);
      }

      if(have_last) {

        int result = emit(last, ticks);

        if(result < 0) {

          break;
        }

        if(result) {

          out_full++;
        } else {

          written++;
        }
      }

      tick_n += ticks;
      next_tick = tick0 + ((tick_n * 1000000 * den) / num);
    }

    if(t >= next_stats) {

      fprintf(stderr, "dgrab: %ld grabs (%ld unchanged), %ld reports, %ld written, %ld repeats, %ld drops, %ld output full\n", grabs, unchanged, reports, written,
        repeats, drops, out_full);
      next_stats = t + REPORT_US;
    }

    // Wait for a report or the next deadline.
    int64_t deadline = last_grab + REFRESH_US;

    if((next_tick >= 0) && (next_tick < deadline)) {

      deadline = next_tick;
    }

    // Waiting for the reader to take the first frame: look again in a millisecond.
    if(primed && (next_tick < 0) && ((now_us() + 1000) < deadline)) {

      deadline = now_us() + 1000;
    }

    if(pending_since >= 0) {

      int64_t settle = last_report + SETTLE_US, cap = pending_since + MAX_SETTLE_US;
      int64_t due = (settle < cap) ? settle : cap;

      if(due < deadline) {

        deadline = due;
      }
    }

    if(!XPending(dpy)) {

      int64_t wait = deadline - now_us();

      if(wait > 0) {

        struct timespec ts = { (time_t)(wait / 1000000), (long)((wait % 1000000) * 1000) };
        struct pollfd p = { fd, POLLIN, 0 };

        ppoll(&p, 1, &ts, NULL);
      }
    }

    while(XPending(dpy)) {

      XEvent ev;

      XNextEvent(dpy, &ev);

      if(ev.type != (dmg_event + XDamageNotify)) {

        continue;
      }

      XDamageNotifyEvent *d = (XDamageNotifyEvent *)&ev;

      reports++;

      if((d->area.x < (rx + rw)) && ((d->area.x + d->area.width) > rx) && (d->area.y < (ry + rh)) && ((d->area.y + d->area.height) > ry)) {

        last_report = now_us();

        if(pending_since < 0) {

          pending_since = last_report;
        }
      }
    }
  }

  pthread_mutex_lock(&out_lock);

  if(!out_done) {

    out_done = 1;
  }

  pthread_cond_signal(&out_cond);
  pthread_mutex_unlock(&out_lock);

  if(!stopping) {

    pthread_join(writer_thread, NULL);
  }

  fprintf(stderr, "dgrab: %ld grabs (%ld unchanged), %ld reports, %ld written, %ld repeats, %ld drops, %ld output full\n", grabs, unchanged, reports, written,
    repeats, drops, out_full);
  XDamageDestroy(dpy, damage);
  XCloseDisplay(dpy);

  return 0;
}
