import React, { useEffect } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
// 全局样式
import './app.scss';

function App(props) {
  useEffect(() => {
    // 微信小程序环境初始化云开发（env 在部署后通过 CloudBase MCP 获取并回填）
    if (process.env.TARO_ENV === 'weapp') {
      if (Taro.cloud) {
        Taro.cloud.init({ env: '', traceUser: true });
      }
    }
  }, []);

  // 对应 onShow
  useDidShow(() => {});

  // 对应 onHide
  useDidHide(() => {});

  return props.children;
}

export default App;
