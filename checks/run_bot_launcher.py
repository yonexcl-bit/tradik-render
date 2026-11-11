# -*- coding: utf-8 -*-
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE)
sys.stdout = open(os.path.join(BASE, "bot_runtime.log"), "a", encoding="utf-8")
sys.stderr = sys.stdout

SCRIPT = "receipt_bot_v108.py"
src = open(os.path.join(BASE, SCRIPT), encoding="utf-8").read()
code = compile(src, SCRIPT, "exec")
g = {"__name__": "__main__", "__file__": os.path.join(BASE, SCRIPT)}
exec(code, g)