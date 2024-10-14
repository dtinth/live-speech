import { useEffect, useRef, useState } from "react";
import { addLogListener } from "../logbus";

export function LogViewer() {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(autoScroll);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);
  useEffect(() => {
    return addLogListener({
      onLog(message) {
        if (ref.current && autoScrollRef.current) {
          ref.current.value += message + "\n";
          ref.current.scrollTop = ref.current.scrollHeight;
        }
      },
    });
  }, []);
  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={ref}
        readOnly
        className="form-control"
        style={{ height: "200px" }}
      />
      <div className="mt-2">
        {/* auto scroll checkbox */}
        <div className="form-check form-switch">
          <input
            className="form-check-input"
            type="checkbox"
            id="autoScroll"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="autoScroll">
            Auto scroll
          </label>
        </div>
      </div>
    </div>
  );
}
