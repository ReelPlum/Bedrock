"""Builds a tiny stand-in for Pix2Text MFR's ONNX files, with the same input
and output names as Optimum's export (encoder: pixel_values ->
last_hidden_state; decoder: input_ids + encoder_hidden_states -> logits),
for the browser test of the formula recogniser. It "reads" every image as
token 5 6 7 then </s>: 1 (<s>) -> 5 -> 6 -> 7 -> 2.

    python -m venv v && v/bin/pip install onnx && v/bin/python make-mfr.py
"""
import os
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

here = os.path.join(os.path.dirname(__file__), "mfr")
V = 10

enc = helper.make_graph(
    [
        helper.make_node("ReduceMean", ["pixel_values"], ["m"], axes=[2, 3], keepdims=0),
        helper.make_node("Unsqueeze", ["m", "ax"], ["last_hidden_state"]),
    ],
    "encoder",
    [helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, 384, 384])],
    [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, [1, 1, 3])],
    [numpy_helper.from_array(np.array([1], dtype=np.int64), "ax")],
)

table = np.full((V, V), -10.0, dtype=np.float32)
for a, b in [(1, 5), (5, 6), (6, 7), (7, 2), (0, 2), (2, 2), (3, 2), (4, 2), (8, 2), (9, 2)]:
    table[a, b] = 10.0
dec = helper.make_graph(
    [
        helper.make_node("Gather", ["table", "input_ids"], ["g"], axis=0),
        helper.make_node("ReduceSum", ["encoder_hidden_states"], ["s"], keepdims=0),
        helper.make_node("Mul", ["s", "zero"], ["z"]),
        helper.make_node("Add", ["g", "z"], ["logits"]),
    ],
    "decoder",
    [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "t"]),
        helper.make_tensor_value_info("encoder_hidden_states", TensorProto.FLOAT, [1, "s", "h"]),
    ],
    [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, "t", V])],
    [numpy_helper.from_array(table, "table"), numpy_helper.from_array(np.array(0, dtype=np.float32), "zero")],
)

for name, g in [("encoder_model.onnx", enc), ("decoder_model.onnx", dec)]:
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)])
    m.ir_version = 8
    onnx.checker.check_model(m)
    onnx.save(m, os.path.join(here, name))
print("ok")
