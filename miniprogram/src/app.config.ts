export default defineAppConfig({
  pages: [
    'pages/today/index',
    'pages/history/index',
    'pages/mine/index',
    'pages/result/index',
    'pages/points/index',
    'pages/submit/index',
    'pages/about/index'
  ],
  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#0b0c0a',
    navigationBarTitleText: '今天你几成',
    navigationBarTextStyle: 'white',
    backgroundColor: '#0b0c0a'
  },
  tabBar: {
    color: '#82867b',
    selectedColor: '#d4ff3f',
    backgroundColor: '#171914',
    borderStyle: 'black',
    list: [
      {
        pagePath: 'pages/today/index',
        text: '今天',
        iconPath: 'assets/tabbar/today.png',
        selectedIconPath: 'assets/tabbar/today-selected.png'
      },
      {
        pagePath: 'pages/history/index',
        text: '往期',
        iconPath: 'assets/tabbar/history.png',
        selectedIconPath: 'assets/tabbar/history-selected.png'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.png',
        selectedIconPath: 'assets/tabbar/mine-selected.png'
      }
    ]
  }
})
