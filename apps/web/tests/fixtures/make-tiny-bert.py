"""A tiny stand-in "BERT" (an embedding lookup), for the browser test that
Transformers.js really runs on the ONNX Runtime the recogniser hands it.

    python -m venv v && v/bin/pip install onnx && v/bin/python make-tiny-bert.py
"""
import json, os
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

here = os.path.join(os.path.dirname(__file__), "tiny-bert")
V, H = 8, 4
table = np.arange(V * H, dtype=np.float32).reshape(V, H)
g = helper.make_graph(
    [
        helper.make_node("Gather", ["table", "input_ids"], ["g"], axis=0),
        helper.make_node("Cast", ["attention_mask"], ["m"], to=TensorProto.FLOAT),
        helper.make_node("Unsqueeze", ["m", "ax"], ["m3"]),
        helper.make_node("Mul", ["g", "m3"], ["last_hidden_state"]),
    ],
    "tiny",
    [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "n"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, "n"]),
    ],
    [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, [1, "n", H])],
    [numpy_helper.from_array(table, "table"), numpy_helper.from_array(np.array([2], dtype=np.int64), "ax")],
)
m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)])
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, os.path.join(here, "onnx", "model.onnx"))
json.dump({"model_type": "bert", "architectures": ["BertModel"], "hidden_size": H, "vocab_size": V}, open(os.path.join(here, "config.json"), "w"))
print("ok")
