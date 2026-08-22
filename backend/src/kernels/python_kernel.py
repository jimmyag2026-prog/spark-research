#!/usr/bin/env python3
import io
import json
import sys
import traceback


class PythonKernel:
    def __init__(self):
        self.namespace = {"__name__": "__main__"}

    def _jsonable(self, obj):
        if obj is None or isinstance(obj, (bool, int, float, str)):
            return obj
        if isinstance(obj, (list, tuple)):
            return [self._jsonable(x) for x in obj]
        if isinstance(obj, dict):
            return {str(k): self._jsonable(v) for k, v in obj.items()}
        try:
            import numpy as np
            if isinstance(obj, np.generic):
                return obj.item()
            if isinstance(obj, np.ndarray):
                return obj.tolist()
        except ImportError:
            pass
        try:
            import pandas as pd
            if isinstance(obj, pd.DataFrame):
                return obj.to_dict(orient="records")
            if isinstance(obj, pd.Series):
                return obj.to_dict()
        except ImportError:
            pass
        return str(obj)

    def execute(self, code):
        old_stdout, old_stderr = sys.stdout, sys.stderr
        out, err = io.StringIO(), io.StringIO()
        sys.stdout, sys.stderr = out, err
        status, result, error = "ok", None, None
        try:
            try:
                result = eval(code, self.namespace)
                self.namespace["_"] = result
            except SyntaxError:
                exec(compile(code, "<kernel>", "exec"), self.namespace)
        except KeyboardInterrupt:
            status = "error"
            error = "KeyboardInterrupt"
        except Exception:
            status = "error"
            error = traceback.format_exc()
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr
        return {
            "status": status,
            "stdout": out.getvalue(),
            "stderr": err.getvalue(),
            "error": error,
            "result": self._jsonable(result),
        }


def main():
    kernel = PythonKernel()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rtype = req.get("type")
        if rtype == "execute":
            resp = kernel.execute(req.get("code", ""))
            resp["type"] = "result"
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        elif rtype == "shutdown":
            break


if __name__ == "__main__":
    main()
