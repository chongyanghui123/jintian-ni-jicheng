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
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '今天你几成',
    navigationBarTextStyle: 'black'
  },
  tabBar: {
    color: '#86909c',
    selectedColor: '#5b4fe9',
    backgroundColor: '#ffffff',
    borderStyle: 'black',
    list: [
      {
        pagePath: 'pages/today/index',
        text: '今天',
        iconPath: 'assets/tabbar/today.svg',
        selectedIconPath: 'assets/tabbar/today-selected.svg'
      },
      {
        pagePath: 'pages/history/index',
        text: '往期',
        iconPath: 'assets/tabbar/history.svg',
        selectedIconPath: 'assets/tabbar/history-selected.svg'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.svg',
        selectedIconPath: 'assets/tabbar/mine-selected.svg'
      }
    ]
  }
})
