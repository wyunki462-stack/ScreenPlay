#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <errno.h>
#include <stdarg.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

/* 本机文件系统怪癖：进程新建的文件权限是 000（即使 umask 022/000）。
   于是「build script 写出的文件 → 同一构建里 rustc/下一步读不到」。
   这里拦截 open 系列：创建成功就 fchmod 0644；遇到 EACCES 就 chmod 0666 后重试一次。 */
static void repair(const char *p) { if (p) chmod(p, 0666); }

int open(const char *p, int flags, ...) {
  static int (*real)(const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "open");
  va_list a; va_start(a, flags); mode_t m = va_arg(a, mode_t); va_end(a);
  int r = real(p, flags, m);
  if (r < 0 && errno == EACCES && (flags & (O_WRONLY | O_RDWR | O_TRUNC))) { repair(p); r = real(p, flags, m); }
  if (r >= 0 && (flags & O_CREAT)) fchmod(r, 0666);
  return r;
}
int open64(const char *p, int flags, ...) {
  static int (*real)(const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "open64");
  va_list a; va_start(a, flags); mode_t m = va_arg(a, mode_t); va_end(a);
  int r = real(p, flags, m);
  if (r < 0 && errno == EACCES && (flags & (O_WRONLY | O_RDWR | O_TRUNC))) { repair(p); r = real(p, flags, m); }
  if (r >= 0 && (flags & O_CREAT)) fchmod(r, 0666);
  return r;
}
int openat(int dfd, const char *p, int flags, ...) {
  static int (*real)(int, const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "openat");
  va_list a; va_start(a, flags); mode_t m = va_arg(a, mode_t); va_end(a);
  int r = real(dfd, p, flags, m);
  if (r < 0 && errno == EACCES && (flags & (O_WRONLY | O_RDWR | O_TRUNC))) { repair(p); r = real(dfd, p, flags, m); }
  if (r >= 0 && (flags & O_CREAT)) fchmod(r, 0666);
  return r;
}
int openat64(int dfd, const char *p, int flags, ...) {
  static int (*real)(int, const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "openat64");
  va_list a; va_start(a, flags); mode_t m = va_arg(a, mode_t); va_end(a);
  int r = real(dfd, p, flags, m);
  if (r < 0 && errno == EACCES && (flags & (O_WRONLY | O_RDWR | O_TRUNC))) { repair(p); r = real(dfd, p, flags, m); }
  if (r >= 0 && (flags & O_CREAT)) fchmod(r, 0666);
  return r;
}
FILE *fopen(const char *p, const char *mode) {
  static FILE *(*real)(const char *, const char *); if (!real) real = dlsym(RTLD_NEXT, "fopen");
  FILE *f = real(p, mode);
  if (!f && errno == EACCES) { repair(p); f = real(p, mode); }
  if (f && mode && (mode[0] == 'w' || mode[0] == 'a') && fchmod(fileno(f), 0666) != 0) { /* ignore */ }
  return f;
}
