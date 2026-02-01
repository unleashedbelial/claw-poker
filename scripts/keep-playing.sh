#!/bin/bash
# Ping tables every 30 seconds to keep bots playing
while true; do
  curl -s -X POST "http://localhost:3001/api/table/micro-1/start" > /dev/null 2>&1
  curl -s -X POST "http://localhost:3001/api/table/low-1/start" > /dev/null 2>&1
  sleep 30
done
