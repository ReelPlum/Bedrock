// A C interface to Google's Ink Stroke Modeler, for Rust.
#include <vector>
#include "ink_stroke_modeler/params.h"
#include "ink_stroke_modeler/stroke_modeler.h"
#include "ink_stroke_modeler/types.h"

using namespace ink::stroke_model;

struct IsmModeler {
  StrokeModeler modeler;
  std::vector<Result> results;
};

extern "C" {

struct IsmParams {
  double wobble_timeout, wobble_speed_floor, wobble_speed_ceiling;
  float spring_mass_constant, drag_constant;
  double min_output_rate;
  float end_of_stroke_stopping_distance;
  int end_of_stroke_max_iterations;
  int predict;  // 0: none, 1: stroke end, 2: Kalman
};

struct IsmResult {
  float x, y, vx, vy, ax, ay;
  double time;
  float pressure, tilt, orientation;
};

IsmModeler* ism_new() { return new IsmModeler(); }
void ism_free(IsmModeler* m) { delete m; }

int ism_reset(IsmModeler* m, const IsmParams* p) {
  StrokeModelParams params;
  params.wobble_smoother_params.timeout = Duration(p->wobble_timeout);
  params.wobble_smoother_params.speed_floor = p->wobble_speed_floor;
  params.wobble_smoother_params.speed_ceiling = p->wobble_speed_ceiling;
  params.position_modeler_params.spring_mass_constant = p->spring_mass_constant;
  params.position_modeler_params.drag_constant = p->drag_constant;
  params.position_modeler_params.loop_contraction_mitigation_params.min_speed_sampling_window = Duration(0);
  params.sampling_params.min_output_rate = p->min_output_rate;
  params.sampling_params.end_of_stroke_stopping_distance = p->end_of_stroke_stopping_distance;
  params.sampling_params.end_of_stroke_max_iterations = p->end_of_stroke_max_iterations;
  if (p->predict == 0) params.prediction_params = DisabledPredictorParams{};
  else params.prediction_params = StrokeEndPredictorParams{};
  return static_cast<int>(m->modeler.Reset(params).code());
}

// kind: 0 down, 1 move, 2 up. Returns a status code (0 ok); the results are
// read with ism_results.
int ism_update(IsmModeler* m, int kind, float x, float y, double time, float pressure, float tilt,
               float orientation) {
  Input in;
  in.event_type = kind == 0 ? Input::EventType::kDown
                  : kind == 1 ? Input::EventType::kMove
                              : Input::EventType::kUp;
  in.position = Vec2{x, y};
  in.time = Time(time);
  in.pressure = pressure;
  in.tilt = tilt;
  in.orientation = orientation;
  m->results.clear();
  return static_cast<int>(m->modeler.Update(in, m->results).code());
}

int ism_predict(IsmModeler* m) {
  m->results.clear();
  return static_cast<int>(m->modeler.Predict(m->results).code());
}

size_t ism_result_count(const IsmModeler* m) { return m->results.size(); }

void ism_result(const IsmModeler* m, size_t i, IsmResult* out) {
  const Result& r = m->results[i];
  *out = IsmResult{r.position.x, r.position.y, r.velocity.x, r.velocity.y, r.acceleration.x,
                   r.acceleration.y, r.time.Value(), r.pressure, r.tilt, r.orientation};
}
}
