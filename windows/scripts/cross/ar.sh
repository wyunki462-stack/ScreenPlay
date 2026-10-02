#!/bin/sh
# 交叉编译用 archiver 垫片：zig ar。
exec "${SP_ZIG:-zig}" ar "$@"
