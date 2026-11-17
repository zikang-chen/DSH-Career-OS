// CareerOS dashboard — client half of the bundle.
//
// Plain JavaScript on purpose: this file is wrapped into the DSH "wrapped module"
// format by scripts/build-client.mjs, so no JSX/bundler step is needed. React and
// react-dom arrive through the host module table via `require`.
const React = require('react')
const { createPortal } = require('react-dom')

const h = React.createElement
const { useCallback, useEffect, useMemo, useRef, useState } = React

const API = '/plugins/dsh-career/api'
let careerAgentBridge = null
function unwrapCareerRemote(result) {
  if(result?.ok === false)throw new Error(result.error?.message || '会话操作失败')
  return result?.ok === true ? result.value : result
}
