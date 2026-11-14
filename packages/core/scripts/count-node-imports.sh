#!/usr/bin/env bash
# How many src files import Node built-ins (decides whether a platform module is worth adding).
grep -rlE "from 'node:" src | wc -l
